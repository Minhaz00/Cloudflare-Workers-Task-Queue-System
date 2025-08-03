/// <reference types="@cloudflare/workers-types" />

interface Env {
  TASK_BUFFER: KVNamespace;
}

interface QueueMessage {
  taskId: string;
  type: string;
  payload: any;
  createdAt: string;
}

interface BufferedTask extends QueueMessage {
  status: 'ready' | 'processing' | 'completed';
  receivedAt: string;
  claimedAt?: string;
}

export default {
  // Handle queue messages - store them in KV buffer
  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    console.log(`Processing batch of ${batch.messages.length} messages`);
    
    for (const message of batch.messages) {
      try {
        console.log('Queue received task:', message.body);
        
        const bufferedTask: BufferedTask = {
          ...message.body,
          status: 'ready',
          receivedAt: new Date().toISOString()
        };
        
        // Store task in KV buffer for local consumer to poll
        await env.TASK_BUFFER.put(
          `task:${message.body.taskId}`, 
          JSON.stringify(bufferedTask),
          { expirationTtl: 86400 } // 24 hours TTL
        );
        
        console.log(`Task ${message.body.taskId} buffered for consumer`);
        
      } catch (error) {
        console.error('Error buffering queue message:', error);
        throw error; // This will cause the message to be retried
      }
    }
  },

  // HTTP handlers for local consumer to poll
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Health check
      if (url.pathname === '/health' && request.method === 'GET') {
        return new Response(JSON.stringify({
          status: 'healthy',
          timestamp: new Date().toISOString(),
          service: 'queue-buffer-v2'
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Get ready tasks for consumer
      if (url.pathname === '/tasks/ready' && request.method === 'GET') {
        const list = await env.TASK_BUFFER.list({ prefix: 'task:' });
        const readyTasks: BufferedTask[] = [];
        
        for (const key of list.keys) {
          const taskData = await env.TASK_BUFFER.get(key.name);
          if (taskData) {
            const task: BufferedTask = JSON.parse(taskData);
            if (task.status === 'ready') {
              readyTasks.push(task);
            }
          }
        }
        
        return new Response(JSON.stringify({
          tasks: readyTasks,
          count: readyTasks.length,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Mark task as processing (claim task)
      if (url.pathname.match(/^\/tasks\/[^\/]+\/claim$/) && request.method === 'POST') {
        const taskId = url.pathname.split('/')[2];
        const taskData = await env.TASK_BUFFER.get(`task:${taskId}`);
        
        if (!taskData) {
          return new Response(JSON.stringify({ 
            error: 'Task not found',
            taskId 
          }), {
            status: 404,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        const task: BufferedTask = JSON.parse(taskData);
        if (task.status !== 'ready') {
          return new Response(JSON.stringify({ 
            error: 'Task not available',
            taskId,
            currentStatus: task.status 
          }), {
            status: 409,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        
        // Mark as processing
        task.status = 'processing';
        task.claimedAt = new Date().toISOString();
        
        await env.TASK_BUFFER.put(`task:${taskId}`, JSON.stringify(task));
        
        console.log(`Task ${taskId} claimed by consumer`);
        
        return new Response(JSON.stringify({
          success: true,
          task,
          message: 'Task claimed successfully'
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // Complete task (remove from buffer)
      if (url.pathname.match(/^\/tasks\/[^\/]+\/complete$/) && request.method === 'POST') {
        const taskId = url.pathname.split('/')[2];
        
        // Remove from buffer
        await env.TASK_BUFFER.delete(`task:${taskId}`);
        
        console.log(`Task ${taskId} removed from buffer`);
        
        return new Response(JSON.stringify({
          success: true,
          message: 'Task removed from buffer',
          taskId
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      // List all tasks in buffer (for debugging)
      if (url.pathname === '/tasks/all' && request.method === 'GET') {
        const list = await env.TASK_BUFFER.list({ prefix: 'task:' });
        const allTasks: BufferedTask[] = [];
        
        for (const key of list.keys) {
          const taskData = await env.TASK_BUFFER.get(key.name);
          if (taskData) {
            allTasks.push(JSON.parse(taskData));
          }
        }
        
        return new Response(JSON.stringify({
          tasks: allTasks,
          count: allTasks.length,
          timestamp: new Date().toISOString()
        }), {
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      
      return new Response(JSON.stringify({
        error: 'Not Found',
        path: url.pathname,
        method: request.method
      }), { 
        status: 404, 
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
      
    } catch (error) {
      console.error('Worker error:', error);
      return new Response(JSON.stringify({ 
        error: 'Internal server error',
        message: error instanceof Error ? error.message : 'Unknown error'
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }
};