import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import { kv, createClient } from '@vercel/kv';

export const prerender = false;

const dataPath = path.resolve('./src/data/tasks.json');
// Check production status securely
const getEnv = (key: string) => {
    if (typeof process !== 'undefined' && process.env) {
        // Accessing via string index to bypass Vite static analysis
        const env = process.env as any;
        return env[key];
    }
    return undefined;
};

const isProduction = !!getEnv('KV_REST_API_URL') || !!getEnv('REDIS_URL') || !!getEnv('VERCEL');

// Initialize client with whatever credentials we can find
function getKVClient() {
    const url = getEnv('KV_REST_API_URL') || getEnv('UPSTASH_REDIS_REST_URL');
    const token = getEnv('KV_REST_API_TOKEN') || getEnv('UPSTASH_REDIS_REST_TOKEN');

    if (url && token) {
        return createClient({ url, token });
    }

    const redisUrl = getEnv('REDIS_URL');
    if (redisUrl?.startsWith('redis://')) {
        try {
            const u = new URL(redisUrl);
            const host = u.hostname;
            const password = u.password;
            // Best-effort REST URL construction
            return createClient({ url: `https://${host}`, token: password });
        } catch {
            return kv;
        }
    }

    return kv;
}

const kvClient = getKVClient();

async function getTasks() {
    try {
        if (isProduction) {
            // Very short timeout (2s) to prevent any perceived slowness
            const fetchPromise = kvClient.get('tasks');
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error("Conexão lenta (2s)")), 2000)
            );

            const tasks = await Promise.race([fetchPromise, timeoutPromise]) as any[];
            return tasks || [];
        }
        const fileContent = await fs.readFile(dataPath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error: any) {
        console.error("GET Error:", error);
        // For internal getTasks, we still return an empty array, but log the error.
        // The APIRoute will then handle returning the error response.
        return [];
    }
}

async function saveTasks(tasks: any[]) {
    if (isProduction) {
        const setPromise = kvClient.set('tasks', tasks);
        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Timeout ao salvar (5s)")), 5000)
        );
        await Promise.race([setPromise, timeoutPromise]);
    } else {
        await fs.writeFile(dataPath, JSON.stringify(tasks, null, 2));
    }
}

export const GET: APIRoute = async () => {
    const tasks = await getTasks();
    return new Response(JSON.stringify(tasks), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
};

export const POST: APIRoute = async ({ request }) => {
    try {
        const body = await request.json();
        const tasks = await getTasks() as any[];

        if (Array.isArray(body)) {
            const tasksWithIds = body.map(task => ({
                ...task,
                id: (Date.now() + Math.random()).toString(),
                title: task.focus_keyword || task.title || 'Sem título'
            }));
            tasks.push(...tasksWithIds);
            await saveTasks(tasks);
            return new Response(JSON.stringify(tasksWithIds), { status: 201 });
        } else {
            const taskWithId = {
                ...body,
                id: Date.now().toString(),
                title: body.focus_keyword || body.title || 'Sem título'
            };
            tasks.push(taskWithId);
            await saveTasks(tasks);
            return new Response(JSON.stringify(taskWithId), { status: 201 });
        }
    } catch (error: any) {
        return new Response(JSON.stringify({ error: `Erro POST: ${error.message}` }), { status: 500 });
    }
};

export const DELETE: APIRoute = async ({ request }) => {
    try {
        const { id, ids } = await request.json();
        const tasks = await getTasks() as any[];

        let updatedTasks;
        if (ids && Array.isArray(ids)) {
            updatedTasks = tasks.filter(t => !ids.includes(t.id));
        } else {
            updatedTasks = tasks.filter(t => t.id !== id);
        }

        await saveTasks(updatedTasks);
        return new Response(JSON.stringify({ success: true }), { status: 200 });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: `Erro DELETE: ${error.message}` }), { status: 500 });
    }
};

export const PUT: APIRoute = async ({ request }) => {
    try {
        const updatedTask = await request.json();
        let tasks = await getTasks() as any[];

        const index = tasks.findIndex((t: any) => t.id === updatedTask.id);
        if (index !== -1) {
            tasks[index] = { ...tasks[index], ...updatedTask };
            await saveTasks(tasks);
            return new Response(JSON.stringify(tasks[index]), { status: 200 });
        }

        return new Response(JSON.stringify({ error: 'Tarefa não encontrada' }), { status: 404 });
    } catch (error: any) {
        return new Response(JSON.stringify({ error: `Erro PUT: ${error.message}` }), { status: 500 });
    }
};
