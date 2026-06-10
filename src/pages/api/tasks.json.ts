import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import Redis from 'ioredis';
import { kv, createClient } from '@vercel/kv';

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

const isProduction = !!(getEnv('VERCEL'));

// Redis client - supports both ioredis (REDIS_URL) and Vercel KV (KV_REST_API_URL + token)
let redisClient: Redis | null = null;
let kvClient: any = null;

function getRedisClient() {
    if (redisClient) return redisClient;

    const redisUrl = getEnv('REDIS_URL');
    if (redisUrl && redisUrl.startsWith('redis://')) {
        redisClient = new Redis(redisUrl, {
            connectTimeout: 10000,
            maxRetriesPerRequest: 1
        });
        return redisClient;
    }
    return null;
}

function getKVClient() {
    if (kvClient) return kvClient;

    const url = getEnv('KV_REST_API_URL') || getEnv('KV_URL') || getEnv('UPSTASH_REDIS_REST_URL');
    const token = getEnv('KV_REST_API_TOKEN') || getEnv('KV_TOKEN') || getEnv('UPSTASH_REDIS_REST_TOKEN');

    if (url && token) {
        const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
        kvClient = createClient({ url: cleanUrl, token });
        return kvClient;
    }
    return null;
}

function getClient() {
    // Try ioredis first (REDIS_URL)
    const redis = getRedisClient();
    if (redis) return { type: 'redis', client: redis };

    // Fallback to Vercel KV
    const kv = getKVClient();
    if (kv) return { type: 'kv', client: kv };

    return null;
}

async function getTasks() {
    try {
        if (isProduction) {
            const client = getClient();
            if (!client) throw new Error("Redis não configurado em produção");

            if (client.type === 'redis') {
                const data = await client.client.get('tasks');
                if (!data) return [];
                return JSON.parse(data);
            } else {
                // Vercel KV
                const data = await client.client.get('tasks');
                return data || [];
            }
        }
        const fileContent = await fs.readFile(dataPath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error: any) {
        console.error("GET Error:", error);
        return [];
    }
}

async function saveTasks(tasks: any[]) {
    if (isProduction) {
        const client = getClient();
        if (!client) {
            console.error("SAVE Error: Redis não configurado");
            throw new Error("Redis não configurado");
        }
        try {
            if (client.type === 'redis') {
                await client.client.set('tasks', JSON.stringify(tasks));
            } else {
                // Vercel KV
                await client.client.set('tasks', tasks);
            }
        } catch (error: any) {
            console.error("SAVE Redis Error:", error.message);
            throw error;
        }
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
        const rawText = await request.text();
        console.log("POST raw body:", rawText.substring(0, 500));

        let body;
        try {
            body = JSON.parse(rawText);
        } catch (parseError: any) {
            console.error("JSON parse error:", parseError.message);
            return new Response(JSON.stringify({
                error: "JSON inválido",
                details: parseError.message,
                rawPreview: rawText.substring(0, 200)
            }), { status: 400 });
        }

        const tasks = await getTasks() as any[];
        console.log("Current tasks count:", tasks.length);

        if (Array.isArray(body)) {
            console.log("Bulk import:", body.length, "tasks");
            const tasksWithIds = body.map((task, idx) => {
                if (!task.focus_keyword && !task.title) {
                    console.warn(`Task ${idx} missing focus_keyword and title`);
                }
                return {
                    ...task,
                    id: (Date.now() + Math.random()).toString(),
                    title: task.focus_keyword || task.title || 'Sem título'
                };
            });
            tasks.push(...tasksWithIds);
            await saveTasks(tasks);
            console.log("Saved", tasksWithIds.length, "tasks. Total:", tasks.length);
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
        console.error("POST Error:", error);
        return new Response(JSON.stringify({
            error: `Erro POST: ${error.message}`,
            stack: error.stack
        }), { status: 500 });
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
