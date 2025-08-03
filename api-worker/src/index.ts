import { Hono } from 'hono';
import { cors } from 'hono/cors';

// Import KVNamespace type from @cloudflare/workers-types if available
import type { KVNamespace } from '@cloudflare/workers-types';

interface Queue {
  send: (message: any) => Promise<void>;
}

interface Env {
  TASK_STORAGE: KVNamespace;
  TASK_QUEUE_V2: Queue;
}

interface Task {
  id: string;
  type: string;
  payload: any;
  createdAt: string;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  completedAt?: string;
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('/*', cors());

// Health check
app.get('/health', (c) => {
  return c.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    service: 'task-api-v2'
  });
});

// Create new task
app.post('/tasks', async (c) => {
  try {
    const { type, payload } = await c.req.json();
    
    if (!type) {
      return c.json({ error: 'Task type is required' }, 400);
    }

    const taskId = crypto.randomUUID();
    const task: Task = {
      id: taskId,
      type,
      payload,
      createdAt: new Date().toISOString(),
      status: 'pending'
    };

    // Store task in KV
    await c.env.TASK_STORAGE.put(`task:${taskId}`, JSON.stringify(task));

    // Send task to queue
    await c.env.TASK_QUEUE_V2.send({
      taskId,
      type,
      payload,
      createdAt: task.createdAt
    });

    console.log(`Task created and queued: ${taskId}`);

    return c.json({
      success: true,
      taskId,
      status: 'pending',
      message: 'Task queued successfully'
    }, 201);

  } catch (error) {
    console.error('Error creating task:', error);
    return c.json({ error: 'Failed to create task' }, 500);
  }
});

// Get task status
app.get('/tasks/:id/status', async (c) => {
  try {
    const taskId = c.req.param('id');
    const taskData = await c.env.TASK_STORAGE.get(`task:${taskId}`);

    if (!taskData) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const task: Task = JSON.parse(taskData);
    return c.json({
      taskId: task.id,
      status: task.status,
      type: task.type,
      createdAt: task.createdAt,
      completedAt: task.completedAt
    });

  } catch (error) {
    console.error('Error getting task status:', error);
    return c.json({ error: 'Failed to get task status' }, 500);
  }
});

// Mark task as completed (called by local consumer)
app.post('/tasks/:id/complete', async (c) => {
  try {
    const taskId = c.req.param('id');
    const { success, result, error } = await c.req.json();

    const taskData = await c.env.TASK_STORAGE.get(`task:${taskId}`);
    if (!taskData) {
      return c.json({ error: 'Task not found' }, 404);
    }

    const task: Task = JSON.parse(taskData);
    task.status = success ? 'completed' : 'failed';
    task.completedAt = new Date().toISOString();

    if (result) {
      (task as any).result = result;
    }
    if (error) {
      (task as any).error = error;
    }

    await c.env.TASK_STORAGE.put(`task:${taskId}`, JSON.stringify(task));

    console.log(`Task ${success ? 'completed' : 'failed'}: ${taskId}`);

    return c.json({
      success: true,
      message: `Task marked as ${task.status}`,
      taskId,
      status: task.status
    });

  } catch (error) {
    console.error('Error completing task:', error);
    return c.json({ error: 'Failed to complete task' }, 500);
  }
});

// List all tasks (for debugging)
app.get('/tasks', async (c) => {
  try {
    const list = await c.env.TASK_STORAGE.list({ prefix: 'task:' });
    const tasks = await Promise.all(
      list.keys.map(async (key) => {
        const data = await c.env.TASK_STORAGE.get(key.name);
        return data ? JSON.parse(data) : null;
      })
    );

    return c.json({
      tasks: tasks.filter(Boolean),
      count: tasks.length
    });
  } catch (error) {
    console.error('Error listing tasks:', error);
    return c.json({ error: 'Failed to list tasks' }, 500);
  }
});

export default app;