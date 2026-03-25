import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import Redis from 'ioredis';

export const prerender = false;

const dataPath = path.resolve('./src/data/tasks.json');

// Get environment variables safely for Astro/Vercel
const getEnv = (key: string) => {
    try {
        const p = (globalThis as any).process;
        if (p && p.env && p.env[key]) return p.env[key];
        const m = (import.meta as any).env;
        if (m && m[key]) return m[key];
    } catch { }
    return undefined;
};

const isProduction = !!(getEnv('REDIS_URL') || getEnv('KV_URL') || getEnv('VERCEL'));

// Global Redis instance for connection reuse
let redisClient: Redis | null = null;

function getClient() {
    if (redisClient) return redisClient;

    const redisUrl = getEnv('REDIS_URL') || getEnv('KV_URL');
    if (redisUrl) {
        // ioredis handles redis:// URLs natively
        redisClient = new Redis(redisUrl, {
            connectTimeout: 10000,
            maxRetriesPerRequest: 1
        });
        return redisClient;
    }
    return null;
}

async function getTasks() {
    try {
        if (isProduction) {
            const client = getClient();
            if (!client) throw new Error("REDIS_URL não configurada em produção");

            const data = await client.get('tasks');
            if (!data) return [];
            return JSON.parse(data);
        }
        const fileContent = await fs.readFile(dataPath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error: any) {
        console.error("GET Error:", error);
        return [];
    }
}

async function saveTasks(tasks: any[]) {
    try {
        if (isProduction) {
            const client = getClient();
            if (!client) throw new Error("REDIS_URL não configurada para salvamento");

            await client.set('tasks', JSON.stringify(tasks));
        } else {
            await fs.writeFile(dataPath, JSON.stringify(tasks, null, 2));
        }
    } catch (error: any) {
        console.error("SAVE Error:", error);
        throw error;
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
