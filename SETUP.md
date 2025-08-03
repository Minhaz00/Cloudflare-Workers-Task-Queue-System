# Complete Setup Guide

## Step 1: Create Project Structure

```bash
# Create main project directory
mkdir cf-task-queue-v2
cd cf-task-queue-v2

# Create component directories
mkdir api-worker-v2 consumer-worker-v2 local-consumer-v2
mkdir api-worker-v2/src consumer-worker-v2/src local-consumer-v2/src
```

## Step 2: Create Cloudflare Resources

### Create KV Namespaces
```bash
# KV for API worker (task storage)
wrangler kv namespace create "TASK_STORAGE"
# Note the ID: e.g., "abc123def456"

# KV for consumer worker (task buffer)  
wrangler kv namespace create "TASK_BUFFER"
# Note the ID: e.g., "xyz789abc123"

# Optional: Create preview namespaces
wrangler kv namespace create "TASK_STORAGE" --preview
wrangler kv namespace create "TASK_BUFFER" --preview
```

### Create Queue
```bash
# Create new queue
wrangler queues create task-queue-v2
```

## Step 3: Setup API Worker

```bash
cd api-worker-v2

# Initialize package.json and install dependencies
npm init -y
npm install hono
npm install -D @cloudflare/workers-types typescript wrangler
```

Copy the files from **API Worker artifact**:
- `package.json`
- `wrangler.toml` 
- `src/index.ts`

**Update `wrangler.toml`** with your KV namespace ID:
```toml
[[kv_namespaces]]
binding = "TASK_STORAGE"
id = "YOUR_TASK_STORAGE_KV_ID"  # Replace with actual ID
preview_id = "YOUR_TASK_STORAGE_PREVIEW_ID"  # Optional
```

### Deploy API Worker
```bash
wrangler deploy
# Note the URL: https://task-api-v2.poridhiaccess.workers.dev
```

## Step 4: Setup Consumer Worker

```bash
cd ../consumer-worker-v2

# Initialize package.json and install dependencies
npm init -y
npm install -D @cloudflare/workers-types typescript wrangler
```

Copy the files from **Consumer Worker artifact**:
- `package.json`
- `wrangler.toml`
- `src/index.ts`

**Update `wrangler.toml`** with your buffer KV namespace ID:
```toml
[[kv_namespaces]]
binding = "TASK_BUFFER"
id = "YOUR_TASK_BUFFER_KV_ID"  # Replace with actual ID
preview_id = "YOUR_TASK_BUFFER_PREVIEW_ID"  # Optional
```

### Deploy Consumer Worker
```bash
wrangler deploy
# Note the URL: https://queue-buffer-v2.poridhiaccess.workers.dev
```

## Step 5: Setup Local Consumer

```bash
cd ../local-consumer-v2

# Initialize package.json and install dependencies
npm init -y
npm install axios dotenv
npm install -D @types/node tsx typescript
```

Copy the files from **Local Consumer artifact**:
- `package.json`
- `src/index.ts`
- `.env.example`
- `tsconfig.json`

### Configure Environment
```bash
# Copy environment file
cp .env.example .env
```

**Edit `.env`** with your actual worker URLs:
```env
QUEUE_WORKER_URL=https://queue-buffer-v2.poridhiaccess.workers.dev
API_WORKER_URL=https://task-api-v2.poridhiaccess.workers.dev
POLL_INTERVAL=5000
LOG_LEVEL=info
```

## Step 6: Test the Complete System

### Start Local Consumer
```bash
cd local-consumer-v2
npm run dev
```

You should see:
```
[2025-08-03T12:00:00.000Z] [INFO] Consumer initialized with configuration: {...}
[2025-08-03T12:00:00.000Z] [INFO] Testing connections...
[2025-08-03T12:00:00.000Z] [INFO] ✅ Queue worker connection OK: {"status":"healthy",...}
[2025-08-03T12:00:00.000Z] [INFO] ✅ API worker connection OK: {"status":"healthy",...}
[2025-08-03T12:00:00.000Z] [INFO] 📡 Task Consumer started successfully
```

### Test Task Creation (New Terminal)
```bash
# Test API worker health
curl https://task-api-v2.poridhiaccess.workers.dev/health

# Create a simple task
curl -X POST https://task-api-v2.poridhiaccess.workers.dev/tasks \
  -H "Content-Type: application/json" \
  -d '{"type": "email", "payload": {"to": "test@example.com", "subject": "Hello World"}}'

# Create a heavy processing task
curl -X POST https://task-api-v2.poridhiaccess.workers.dev/tasks \
  -H "Content-Type: application/json" \
  -d '{"type": "heavy", "payload": {"data": "large processing task"}}'

# Create a task that will fail (for testing)
curl -X POST https://task-api-v2.poridhiaccess.workers.dev/tasks \
  -H "Content-Type: application/json" \
  -d '{"type": "test", "payload": {"shouldFail": true}}'
```

### Check Task Status
```bash
# List all tasks
curl https://task-api-v2.poridhiaccess.workers.dev/tasks

# Check specific task status (use taskId from create response)
curl https://task-api-v2.poridhiaccess.workers.dev/tasks/{TASK_ID}/status

# Check queue buffer (for debugging)
curl https://queue-buffer-v2.poridhiaccess.workers.dev/tasks/all
```

## Step 7: Expected Flow

1. **Create Task** → API Worker stores in KV and sends to Queue
2. **Queue Consumer** → Receives from queue and stores in buffer KV
3. **Local Consumer** → Polls buffer, claims task, processes it
4. **Completion** → Reports back to API Worker and cleans buffer

### Expected Consumer Output:
```
[INFO] Polling for ready tasks...
[INFO] Found 1 ready task(s)
[INFO] 📨 Processing 1 task(s)
[INFO] Claiming task: abc-123-def
[INFO] Task abc-123-def claimed successfully
[INFO] 🔄 Processing Task: {"id":"abc-123-def","type":"email",...}
[INFO] Simulating email work for 1000ms...
[INFO] 📝 Completion reported to API: {"taskId":"abc-123-def","success":true}
[INFO] 🗑️ Task abc-123-def removed from queue buffer
[INFO] ✅ Task abc-123-def completed successfully
```

## Step 8: Troubleshooting

### Common Issues:

1. **KV Namespace ID Missing**
   ```bash
   # If you forgot to update wrangler.toml
   wrangler kv namespace list  # Find your namespace IDs
   ```

2. **Consumer Can't Connect**
   ```bash
   # Test worker URLs directly
   curl https://queue-buffer-v2.poridhiaccess.workers.dev/health
   curl https://task-api-v2.poridhiaccess.workers.dev/health
   ```

3. **No Tasks Being Processed**
   ```bash
   # Check if tasks are in queue buffer
   curl https://queue-buffer-v2.poridhiaccess.workers.dev/tasks/all
   
   # Check worker logs
   wrangler tail --name queue-buffer-v2
   wrangler tail --name task-api-v2
   ```

4. **Queue Issues**
   ```bash
   # Check queue status
   wrangler queues info task-queue-v2
   
   # Should show:
   # Producers: worker:task-api-v2
   # Consumers: worker:queue-buffer-v2
   ```

## Step 9: Project Structure Summary

```
cf-task-queue-v2/
├── api-worker-v2/
│   ├── src/index.ts
│   ├── package.json
│   └── wrangler.toml
├── consumer-worker-v2/
│   ├── src/index.ts
│   ├── package.json
│   └── wrangler.toml
└── local-consumer-v2/
    ├── src/index.ts
    ├── package.json
    ├── tsconfig.json
    ├── .env
    └── .env.example
```

## Step 10: Next Steps

### Production Enhancements:
- Add authentication to worker endpoints
- Implement task retry logic with exponential backoff
- Add monitoring and alerting
- Scale consumer workers horizontally
- Add task priority queues
- Implement dead letter queues for failed tasks

### Development Features:
- Add task scheduling (delayed execution)
- Implement task dependencies
- Add task progress tracking
- Create a dashboard for monitoring tasks
- Add webhook notifications for task completion

## Resource Names Used:
- **Queue**: `task-queue-v2`
- **API Worker**: `task-api-v2`
- **Consumer Worker**: `queue-buffer-v2`  
- **KV Namespaces**: `TASK_STORAGE`, `TASK_BUFFER`