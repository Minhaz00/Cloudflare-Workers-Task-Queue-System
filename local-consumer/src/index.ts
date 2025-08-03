import axios from 'axios';
import { config } from 'dotenv';

config();

interface BufferedTask {
  taskId: string;
  type: string;
  payload: any;
  createdAt: string;
  status: 'ready' | 'processing' | 'completed';
  receivedAt: string;
  claimedAt?: string;
}

class TaskConsumer {
  private queueWorkerUrl: string;
  private apiWorkerUrl: string;
  private pollInterval: number;
  private isRunning = false;
  private logLevel: string;

  constructor() {
    this.queueWorkerUrl = process.env.QUEUE_WORKER_URL!;
    this.apiWorkerUrl = process.env.API_WORKER_URL!;
    this.pollInterval = parseInt(process.env.POLL_INTERVAL || '5000');
    this.logLevel = process.env.LOG_LEVEL || 'info';

    if (!this.queueWorkerUrl || !this.apiWorkerUrl) {
      throw new Error('QUEUE_WORKER_URL and API_WORKER_URL are required');
    }

    this.log('info', 'Consumer initialized with configuration:', {
      queueWorkerUrl: this.queueWorkerUrl,
      apiWorkerUrl: this.apiWorkerUrl,
      pollInterval: this.pollInterval
    });
  }

  private log(level: 'info' | 'warn' | 'error', message: string, data?: any): void {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level.toUpperCase()}] ${message}`;
    
    if (data) {
      console.log(logMessage, JSON.stringify(data, null, 2));
    } else {
      console.log(logMessage);
    }
  }

  private async getReadyTasks(): Promise<BufferedTask[]> {
    try {
      this.log('info', 'Polling for ready tasks...');
      const response = await axios.get(`${this.queueWorkerUrl}/tasks/ready`, {
        timeout: 10000
      });
      
      const tasks = response.data.tasks || [];
      if (tasks.length > 0) {
        this.log('info', `Found ${tasks.length} ready task(s)`);
      }
      
      return tasks;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.log('error', 'Queue polling error:', {
          status: error.response?.status,
          data: error.response?.data,
          message: error.message
        });
      } else {
        this.log('error', 'Queue polling error:', error);
      }
      return [];
    }
  }

  private async claimTask(taskId: string): Promise<BufferedTask | null> {
    try {
      this.log('info', `Claiming task: ${taskId}`);
      const response = await axios.post(`${this.queueWorkerUrl}/tasks/${taskId}/claim`, {}, {
        timeout: 10000
      });
      
      this.log('info', `Task ${taskId} claimed successfully`);
      return response.data.task;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        this.log('warn', `Failed to claim task ${taskId}:`, {
          status: error.response?.status,
          data: error.response?.data
        });
      } else {
        this.log('error', `Failed to claim task ${taskId}:`, error);
      }
      return null;
    }
  }

  private async processTask(task: BufferedTask): Promise<void> {
    this.log('info', `🔄 Processing Task:`, {
      id: task.taskId,
      type: task.type,
      payload: task.payload,
      createdAt: task.createdAt,
      receivedAt: task.receivedAt,
      claimedAt: task.claimedAt
    });

    try {
      // Simulate task processing
      this.log('info', `Processing task ${task.taskId}...`);
      await this.simulateWork(task.type, task.payload);
      
      // Mark task as completed in API worker
      await this.markTaskCompleted(task.taskId, true, { 
        processedAt: new Date().toISOString(),
        processedBy: 'local-consumer-v2',
        processingDuration: this.getProcessingTime(task.type)
      });
      
      // Remove from queue buffer
      await this.completeTaskInBuffer(task.taskId);
      
      this.log('info', `✅ Task ${task.taskId} completed successfully`);
    } catch (error) {
      this.log('error', `❌ Task ${task.taskId} failed:`, error);
      await this.markTaskCompleted(task.taskId, false, undefined, error);
      await this.completeTaskInBuffer(task.taskId);
    }
  }

  private getProcessingTime(type: string): number {
    switch (type) {
      case 'heavy': return 3000;
      case 'medium': return 2000;
      case 'light': return 500;
      default: return 1000;
    }
  }

  private async simulateWork(type: string, payload: any): Promise<void> {
    const processingTime = this.getProcessingTime(type);
    
    this.log('info', `Simulating ${type} work for ${processingTime}ms...`);
    
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        // Simulate occasional failures
        if (payload.shouldFail) {
          reject(new Error('Simulated task failure'));
        } else {
          resolve();
        }
      }, processingTime);
    });
  }

  private async markTaskCompleted(
    taskId: string, 
    success: boolean, 
    result?: any, 
    error?: any
  ): Promise<void> {
    try {
      const response = await axios.post(
        `${this.apiWorkerUrl}/tasks/${taskId}/complete`,
        {
          success,
          result,
          error: error?.message
        },
        { timeout: 10000 }
      );
      
      this.log('info', `📝 Completion reported to API:`, {
        taskId,
        success,
        response: response.data
      });
    } catch (err) {
      this.log('error', `⚠️ Failed to mark task as completed in API:`, {
        taskId,
        error: err
      });
    }
  }

  private async completeTaskInBuffer(taskId: string): Promise<void> {
    try {
      await axios.post(`${this.queueWorkerUrl}/tasks/${taskId}/complete`, {}, {
        timeout: 10000
      });
      this.log('info', `🗑️ Task ${taskId} removed from queue buffer`);
    } catch (err) {
      this.log('error', `⚠️ Failed to remove task from buffer:`, {
        taskId,
        error: err
      });
    }
  }

  private async testConnections(): Promise<boolean> {
    try {
      this.log('info', 'Testing connections...');
      
      // Test queue worker
      const queueHealth = await axios.get(`${this.queueWorkerUrl}/health`, { timeout: 5000 });
      this.log('info', '✅ Queue worker connection OK:', queueHealth.data);
      
      // Test API worker
      const apiHealth = await axios.get(`${this.apiWorkerUrl}/health`, { timeout: 5000 });
      this.log('info', '✅ API worker connection OK:', apiHealth.data);
      
      return true;
    } catch (error) {
      this.log('error', '❌ Connection test failed:', error);
      return false;
    }
  }

  public async start(): Promise<void> {
    this.log('info', '🚀 Task Consumer starting...');
    
    // Test connections first
    const connectionsOk = await this.testConnections();
    if (!connectionsOk) {
      this.log('error', 'Failed to connect to required services. Exiting...');
      return;
    }

    this.isRunning = true;
    this.log('info', '📡 Task Consumer started successfully');
    this.log('info', `🔄 Polling every ${this.pollInterval}ms`);
    this.log('info', 'Press Ctrl+C to stop');

    while (this.isRunning) {
      try {
        const readyTasks = await this.getReadyTasks();
        
        if (readyTasks.length > 0) {
          this.log('info', `📨 Processing ${readyTasks.length} task(s)`);
          
          // Process tasks one by one to avoid conflicts
          for (const task of readyTasks) {
            if (!this.isRunning) break;
            
            // Claim the task
            const claimedTask = await this.claimTask(task.taskId);
            if (claimedTask) {
              await this.processTask(claimedTask);
            }
          }
        } else {
          this.log('info', `⏰ No ready tasks - next poll in ${this.pollInterval}ms`);
        }
        
        await new Promise(resolve => setTimeout(resolve, this.pollInterval));
      } catch (error) {
        this.log('error', 'Consumer loop error:', error);
        await new Promise(resolve => setTimeout(resolve, this.pollInterval));
      }
    }
  }

  public stop(): void {
    this.isRunning = false;
    this.log('info', '🛑 Task Consumer stopped');
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n📡 Received SIGINT, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n📡 Received SIGTERM, shutting down gracefully...');
  process.exit(0);
});

// Start the consumer
const consumer = new TaskConsumer();
consumer.start().catch((error) => {
  console.error('Failed to start consumer:', error);
  process.exit(1);
});