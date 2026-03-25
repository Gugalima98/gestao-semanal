import type { APIRoute } from 'astro';
import fs from 'node:fs/promises';
import path from 'node:path';
import { kv } from '@vercel/kv';

export const prerender = false;

const dataPath = path.resolve('./src/data/tasks.json');
const isProduction = !!process.env.KV_REST_API_URL;

async function getTasks() {
    try {
        if (isProduction) {
            const tasks = await kv.get('tasks');
            return tasks || [];
        }
        const fileContent = await fs.readFile(dataPath, 'utf-8');
        return JSON.parse(fileContent);
    } catch (error) {
        return [];
    }
}

async function saveTasks(tasks: any[]) {
    if (isProduction) {
        await kv.set('tasks', tasks);
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
    } catch (error) {
        return new Response(JSON.stringify({ error: 'Erro ao processar criação de tarefa(s)' }), { status: 500 });
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
    } catch (error) {
        return new Response(JSON.stringify({ error: 'Erro ao excluir tarefa(s)' }), { status: 500 });
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
    } catch (error) {
        return new Response(JSON.stringify({ error: 'Erro ao atualizar tarefa' }), { status: 500 });
    }
};
