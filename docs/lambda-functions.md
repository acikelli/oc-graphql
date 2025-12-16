# Lambda Functions Guide

OC-GraphQL automatically generates a comprehensive set of Lambda functions to handle all GraphQL operations. This guide explains the function types, execution patterns, and configuration details.

## 🏗️ Function Architecture Overview

### Function Categories

1. **CRUD Functions** - Basic entity operations (Create, Read, Update, Delete)
2. **Query Functions** - Custom SQL query execution
3. **Mutation Functions** - Custom SQL mutations
4. **Task Trigger Mutations** - Start asynchronous long-running queries
5. **Task Result Queries** - Poll task status and retrieve results
6. **Execution Tracker** - EventBridge Lambda for tracking Athena query executions
7. **Stream Processor** - DynamoDB to Parquet data pipeline
8. **Cascade Deletion Listener** - SQS queue listener for cleaning up join table relations
9. **Deletion Listener** - SQS queue listener for DELETE SQL operations

## 📋 Function Naming Patterns

### Naming Convention

Lambda function names use different patterns depending on the function type:

**Hash-Based Naming (for CRUD, Mutations, Task Triggers, Task Results):**
Used to avoid AWS's 64-character limit for functions that may have long names.

```
Pattern: OCG-{project}-{hash}
Where hash = first 16 characters of SHA256({project}-{category}-{identifier})

Examples:
- OCG-blog-a1b2c3d4e5f6g7h8 (for blog-create-user)
- OCG-blog-i9j0k1l2m3n4o5p6 (for blog-mutation-triggerTaskGenerateReport)
- OCG-blog-q7r8s9t0u1v2w3x4 (for blog-query-taskResultGenerateReport)
```

**Descriptive Naming (for project-level functions):**
Used for functions created once per project that won't hit the 64-character limit.

```
Pattern: OCG-{project}-{function-name}

Examples:
- OCG-blog-stream-processor
- OCG-blog-cascade-deletion-listener
- OCG-blog-deletion-listener
- OCG-blog-athena-execution-tracker
```

**Function Identifier Patterns:**

- CRUD: `{project}-{operation}-{entity}` (e.g., `blog-create-user`) → Hash-based
- Mutations: `{project}-mutation-{mutationName}` (e.g., `blog-mutation-likePost`) → Hash-based
- Task Triggers: `{project}-mutation-triggerTask{QueryName}` (e.g., `blog-mutation-triggerTaskGetUsersByCity`) → Hash-based
- Task Results: `{project}-query-taskResult{QueryName}` (e.g., `blog-query-taskResultGetUsersByCity`) → Hash-based
- Stream Processor: `OCG-{project}-stream-processor` → Descriptive (no hash)
- Cascade Deletion Listener: `OCG-{project}-cascade-deletion-listener` → Descriptive (no hash)
- Deletion Listener: `OCG-{project}-deletion-listener` → Descriptive (no hash)
- Athena Execution Tracker: `OCG-{project}-athena-execution-tracker` → Descriptive (no hash)

## 🔧 Function Types & Implementation

### 1. CRUD Functions (Node.js 18.x)

Auto-generated for each entity type to handle basic database operations.

#### Create Function

```javascript
// Pattern: OCG-{project}-{hash} (hash from: {project}-create-{entity})
// Example: OCG-blog-a1b2c3d4e5f6g7h8

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { v4: uuidv4 } = require("uuid");

exports.handler = async (event) => {
  const input = event.arguments.input;
  const id = uuidv4();
  const now = new Date().toISOString();

  const item = {
    PK: `user#${id}`,
    SK: `user#${id}`,
    id,
    ...input,
    entityType: "user",
    createdAt: now,
    updatedAt: now,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(item),
    })
  );

  return item;
};
```

#### Read Function

```javascript
// Pattern: OCG-{project}-{hash} (hash from: {project}-read-{entity})
// Example: OCG-blog-i9j0k1l2m3n4o5p6

const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

exports.handler = async (event) => {
  const id = event.arguments.id;

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `user#${id}` },
        SK: { S: `user#${id}` },
      },
    })
  );

  if (!result.Item) {
    throw new Error("User not found");
  }

  return unmarshall(result.Item);
};
```

#### Update Function

```javascript
// Pattern: OCG-{project}-{hash} (hash from: {project}-update-{entity})
// Example: OCG-blog-q7r8s9t0u1v2w3x4

exports.handler = async (event) => {
  const id = event.arguments.id;
  const input = event.arguments.input;
  const now = new Date().toISOString();

  // Dynamic update expression generation
  const updateExpression = [];
  const expressionAttributeValues = { ":updatedAt": { S: now } };
  const expressionAttributeNames = { "#updatedAt": "updatedAt" };

  Object.entries(input).forEach(([key, value], index) => {
    if (value !== undefined) {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      updateExpression.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = marshall(value);
    }
  });

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { PK: { S: `user#${id}` }, SK: { S: `user#${id}` } },
      UpdateExpression: `SET ${updateExpression.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return { id, ...input, updatedAt: now };
};
```

#### Delete Function

```javascript
// Pattern: OCG-{project}-{hash} (hash from: {project}-delete-{entity})
// Example: OCG-blog-y5z6a7b8c9d0e1f2

exports.handler = async (event) => {
  const id = event.arguments.id;

  await dynamoClient.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `user#${id}` },
        SK: { S: `user#${id}` },
      },
    })
  );

  return { id, deleted: true };
};
```

### 2. Query Functions (Node.js 18.x)

Execute custom SQL queries for complex data retrieval.

```javascript
// Pattern: OCG-{project}-{hash} (hash from: {project}-mutation-{mutationName})
// Example: OCG-blog-c3d4e5f6g7h8i9j0

const {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} = require("@aws-sdk/client-athena");

// SQL injection prevention
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  } else if (typeof value === "number") {
    if (!isFinite(value)) {
      throw new Error("Invalid number value");
    }
    return value.toString();
  } else if (typeof value === "boolean") {
    return value ? "true" : "false";
  } else if (typeof value === "string") {
    let escaped = value.split("'").join("''"); // SQL standard escaping
    return "'" + escaped + "'";
  } else {
    throw new Error("Unsupported data type for SQL parameter");
  }
}

exports.handler = async (event) => {
  let query = `SELECT p.*, COUNT(pl.id) as like_count 
               FROM post p 
               LEFT JOIN post_likes pl ON p.id = pl.post_id 
               WHERE p.published = true
                 AND p.created_at >= current_date - interval '$args.days' day
               GROUP BY p.id 
               ORDER BY like_count DESC 
               LIMIT $args.limit`;

  // Replace parameter placeholders with SQL-safe escaping
  if (event.arguments) {
    Object.entries(event.arguments).forEach(([key, value]) => {
      const argsPattern = "$args." + key;
      const sqlSafeValue = escapeSqlValue(value);
      query = query.split(argsPattern).join(sqlSafeValue);
    });
  }

  // Execute Athena query
  const queryExecution = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      QueryExecutionContext: { Database: DATABASE_NAME },
      ResultConfiguration: { OutputLocation: S3_OUTPUT_LOCATION },
    })
  );

  // Wait for completion and return results
  // ... (polling and result processing logic)

  return data; // Array of results
};
```

### 3. Task Trigger Mutations (Node.js 18.x)

Auto-generated for all `Query` fields to handle long-running Athena queries asynchronously.

**Requirements:**

- All `Query` fields are automatically tasks (no `@task` directive needed)
- The return type must have the `@task_response` directive
- Types with `@task_response` do not generate CRUD operations

```javascript
// Pattern: OCG-{project}-{hash} (hash from: {project}-mutation-triggerTask{QueryName})
// Example: OCG-blog-e1f2g3h4i5j6k7l8

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const {
  AthenaClient,
  StartQueryExecutionCommand,
} = require("@aws-sdk/client-athena");
const { marshall } = require("@aws-sdk/util-dynamodb");

exports.handler = async (event) => {
  const now = new Date().toISOString();

  // Prepare SQL query with parameter replacement
  let sqlQuery = `SELECT month, COUNT(*) as orders FROM orders WHERE year = $args.year GROUP BY month`;

  // Replace parameters
  if (event.arguments) {
    Object.entries(event.arguments).forEach(([key, value]) => {
      const argsPattern = "$args." + key;
      const sqlSafeValue = escapeSqlValue(value);
      sqlQuery = sqlQuery.split(argsPattern).join(sqlSafeValue);
    });
  }

  // Start Athena query execution
  const queryExecution = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: sqlQuery,
      QueryExecutionContext: { Database: DATABASE_NAME },
      ResultConfiguration: { OutputLocation: S3_OUTPUT_LOCATION },
    })
  );

  // Use execution ID as task ID (one query per task)
  const taskId = queryExecution.QueryExecutionId;

  // Create task entity
  const taskItem = {
    PK: `task#${taskId}`,
    SK: `task#${taskId}`,
    id: taskId,
    entityType: "task",
    entityId: taskId,
    taskStatus: "RUNNING",
    startDate: now,
    finishDate: null,
    createdAt: now,
    updatedAt: now,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(taskItem),
    })
  );

  return { taskId }; // taskId is the Athena execution ID
};
```

**Key Features:**

- Uses Athena execution ID as task ID (simplified - one query per task)
- Creates task entity with status tracking
- Returns immediately with taskId (non-blocking)
- No separate execution entity needed

### 4. Task Result Queries (Node.js 18.x)

Poll task status and retrieve results for completed tasks.

```javascript
// Pattern: OCG-{project}-{hash} (hash from: {project}-query-taskResult{QueryName})
// Example: OCG-blog-g5h6i7j8k9l0m1n2

const {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  AthenaClient,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} = require("@aws-sdk/client-athena");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

exports.handler = async (event) => {
  const taskId = event.arguments.taskId; // taskId is the Athena execution ID

  // Get task entity
  const taskResult = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `task#${taskId}` },
        SK: { S: `task#${taskId}` },
      },
    })
  );

  if (!taskResult.Item) {
    throw new Error("Task not found");
  }

  let task = unmarshall(taskResult.Item);
  let taskStatus = task.taskStatus || "RUNNING";
  let finishDate = task.finishDate || null;

  // Poll Athena directly for execution status if still RUNNING
  if (taskStatus === "RUNNING" || taskStatus === "QUEUED") {
    try {
      const execResult = await athenaClient.send(
        new GetQueryExecutionCommand({
          QueryExecutionId: taskId,
        })
      );

      const status = execResult.QueryExecution?.Status?.State || "UNKNOWN";
      const statusChangeDateTime =
        execResult.QueryExecution?.Status?.StateChangeDateTime;

      // Map Athena status to task status
      if (status === "SUCCEEDED") {
        taskStatus = "SUCCEEDED";
      } else if (status === "FAILED" || status === "CANCELLED") {
        taskStatus = "FAILED";
      } else {
        taskStatus = "RUNNING";
      }

      // Update task entity if status changed
      if (task.taskStatus !== taskStatus) {
        const updateExpression =
          taskStatus === "SUCCEEDED" || taskStatus === "FAILED"
            ? "SET taskStatus = :status, finishDate = :finishDate, updatedAt = :updatedAt"
            : "SET taskStatus = :status, updatedAt = :updatedAt";

        const expressionAttributeValues =
          taskStatus === "SUCCEEDED" || taskStatus === "FAILED"
            ? {
                ":status": { S: taskStatus },
                ":finishDate": {
                  S: statusChangeDateTime || new Date().toISOString(),
                },
                ":updatedAt": { S: new Date().toISOString() },
              }
            : {
                ":status": { S: taskStatus },
                ":updatedAt": { S: new Date().toISOString() },
              };

        await dynamoClient.send(
          new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: { S: `task#${taskId}` },
              SK: { S: `task#${taskId}` },
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues,
          })
        );

        // Refresh task to get updated finishDate
        const updatedTaskResult = await dynamoClient.send(
          new GetItemCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: { S: `task#${taskId}` },
              SK: { S: `task#${taskId}` },
            },
          })
        );
        if (updatedTaskResult.Item) {
          task = unmarshall(updatedTaskResult.Item);
          finishDate = task.finishDate || null;
        }
      }
    } catch (error) {
      console.error(`Error polling Athena for execution ${taskId}:`, error);
    }
  }

  // Build result if query completed successfully
  let result = null;
  if (taskStatus === "SUCCEEDED") {
    try {
      const athenaResults = await athenaClient.send(
        new GetQueryResultsCommand({
          QueryExecutionId: taskId,
          MaxResults: 1000,
        })
      );

      const rows = athenaResults.ResultSet?.Rows || [];
      const headers = rows[0]?.Data?.map((col) => col.VarCharValue) || [];
      const data = rows.slice(1).map((row) => {
        const obj = {};
        row.Data?.forEach((col, index) => {
          obj[headers[index]] = col.VarCharValue;
        });
        return obj;
      });

      result = data; // or data[0] for single result
    } catch (error) {
      console.error(`Error retrieving results for execution ${taskId}:`, error);
      result = null;
    }
  }

  return {
    taskStatus,
    result, // Null if still running or failed
    startDate: task.startDate,
    finishDate: finishDate, // Null if still running
  };
};
```

**Key Features:**

- **Hybrid Polling**: Checks DynamoDB first, then polls Athena directly if task is still RUNNING/QUEUED
- **Automatic Updates**: Updates task entity in DynamoDB with latest status and finish date during polling
- **Result Retrieval**: Retrieves results directly from Athena when task succeeds
- **Reliable**: Works even without EventBridge - polling ensures tasks never get stuck
- **Simplified Response**: Only returns `taskStatus`, `result`, `startDate`, and `finishDate`
- Returns null result if task is still RUNNING or FAILED

### 5. Execution Tracker (Node.js 18.x)

EventBridge Lambda that automatically tracks Athena query execution state changes and updates task status.

```javascript
// Pattern: OCG-{project}-athena-execution-tracker (no hash - created once per project)
// Example: OCG-blog-athena-execution-tracker

const {
  DynamoDBClient,
  GetItemCommand,
  UpdateItemCommand,
} = require("@aws-sdk/client-dynamodb");
const {
  AthenaClient,
  GetQueryExecutionCommand,
} = require("@aws-sdk/client-athena");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

exports.handler = async (event) => {
  // EventBridge event structure for Athena Query State Change events
  // {
  //   "detail-type": "Athena Query State Change",
  //   "source": "aws.athena",
  //   "detail": {
  //     "queryExecutionId": "01234567-0123-0123-0123-012345678901",
  //     "currentState": "SUCCEEDED",
  //     "previousState": "RUNNING",
  //     "athenaError": { ... } // Only present when FAILED
  //   }
  // }
  const executionId = event.detail?.queryExecutionId;
  const status = event.detail?.currentState;

  if (!executionId || !status) {
    console.log(
      "Missing executionId or status in event:",
      JSON.stringify(event, null, 2)
    );
    return { statusCode: 400, body: "Missing required fields" };
  }

  // Only process terminal states (SUCCEEDED, FAILED, CANCELLED)
  if (!["SUCCEEDED", "FAILED", "CANCELLED"].includes(status)) {
    console.log(
      `Skipping non-terminal state: ${status} for execution ${executionId}`
    );
    return { statusCode: 200, body: "Skipped - non-terminal state" };
  }

  console.log(
    `Processing Athena execution ${executionId} with status ${status}`
  );

  // Check if task exists (executionId is the taskId)
  const taskResult = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `task#${executionId}` },
        SK: { S: `task#${executionId}` },
      },
    })
  );

  if (!taskResult.Item) {
    console.log(
      `Task entity not found for execution ${executionId} (may not be a task query)`
    );
    return { statusCode: 404, body: "Task not found" };
  }

  // Map Athena status to task status
  let taskStatus = "RUNNING";
  if (status === "SUCCEEDED") {
    taskStatus = "SUCCEEDED";
  } else if (status === "FAILED" || status === "CANCELLED") {
    taskStatus = "FAILED";
  }

  // Get execution details to get finish date
  let finishDate = null;
  try {
    const execResult = await athenaClient.send(
      new GetQueryExecutionCommand({
        QueryExecutionId: executionId,
      })
    );
    finishDate =
      execResult.QueryExecution?.Status?.StateChangeDateTime ||
      new Date().toISOString();
  } catch (error) {
    console.error(`Error getting execution details for ${executionId}:`, error);
    finishDate = new Date().toISOString();
  }

  // Update task entity
  const updateExpression =
    "SET taskStatus = :status, finishDate = :finishDate, updatedAt = :updatedAt";
  const expressionAttributeValues = {
    ":status": { S: taskStatus },
    ":finishDate": { S: finishDate },
    ":updatedAt": { S: new Date().toISOString() },
  };

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `task#${executionId}` },
        SK: { S: `task#${executionId}` },
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  console.log(
    `Successfully updated task ${executionId} with status ${taskStatus}`
  );

  return { statusCode: 200, body: "Success" };
};
```

**Key Features:**

- Listens for native Athena Query State Change events via EventBridge
- Updates task entity with status and finish date
- Uses execution ID as task ID (simplified structure)
- No separate execution entity needed
- Handles both EventBridge and CloudTrail event structures
- **Note**: The `taskResult` query also polls Athena directly as a fallback, so tasks work even without EventBridge

### 6. Stream Processor (Python 3.11)

Real-time DynamoDB to Parquet conversion with advanced optimization, join table support, and automatic Glue table management.

```python
# Pattern: OCG-{project}-stream-processor (no hash - created once per project)
# Example: OCG-blog-stream-processor

import json
import os
import boto3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from datetime import datetime
from io import BytesIO
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
glue_client = boto3.client('glue')

BUCKET_NAME = os.environ['S3_BUCKET_NAME']
GLUE_DATABASE = os.environ['ATHENA_DATABASE_NAME']

def lambda_handler(event, context):
    """Main Lambda handler for DynamoDB stream processing"""
    for record in event['Records']:
        try:
            process_record(record)
        except Exception as e:
            logger.error(f"Error processing record: {str(e)}")
            # Continue processing other records

    return {'statusCode': 200, 'body': 'Stream processing completed'}

def process_record(record):
    """Process individual DynamoDB stream record"""
    try:
        event_name = record['eventName']  # INSERT, MODIFY, REMOVE
        logger.info(f"Processing DynamoDB event: {event_name}")

        current_date = datetime.utcnow()
        year = current_date.strftime('%Y')
        month = current_date.strftime('%m')
        day = current_date.strftime('%d')

        if event_name == 'REMOVE':
            handle_delete_operation(record, current_date, year, month, day)
        else:
            handle_insert_update_operation(record, event_name, current_date, year, month, day)

    except Exception as e:
        logger.error(f"Error processing stream record: {str(e)}")

def handle_delete_operation(record, current_date, year, month, day):
    """Handle DELETE operations by removing Parquet files from S3 and triggering cascade deletion"""
    if 'OldImage' not in record.get('dynamodb', {}):
        return

    item = unmarshall_dynamodb_item(record['dynamodb']['OldImage'])
    entity_type = item.get('entityType')

    if not entity_type:
        return

    # Determine S3 key for deletion with date partitioning
    if item.get('joinTable'):
        # Join table: use composite key from PK/SK
        join_table = item['joinTable']
        pk_parts = item['PK'].split('#')
        sk_parts = item['SK'].split('#')
        key_components = pk_parts[2:] + sk_parts[2:]
        key_string = '_'.join(key_components)

        # Use original creation date for deletion
        item_date = parse_item_date(item.get('createdAt'), current_date)
        item_year, item_month, item_day = format_date_parts(item_date)

        s3_key = f"tables/{join_table}/year={item_year}/month={item_month}/day={item_day}/{key_string}.parquet"

        logger.info(f"Deleting join table S3 object: {s3_key}")

        try:
            s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
            logger.info(f"Successfully deleted join table S3 object: {s3_key}")
        except Exception as e:
            logger.warning(f"S3 object may not exist or already deleted: {s3_key} - {str(e)}")
    else:
        # Regular entity: use ID and trigger cascade deletion
        item_date = parse_item_date(item.get('createdAt'), current_date)
        item_year, item_month, item_day = format_date_parts(item_date)

        s3_key = f"tables/{entity_type}/year={item_year}/month={item_month}/day={item_day}/{item['id']}.parquet"

        logger.info(f"Deleting entity S3 object: {s3_key}")

        try:
            s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
            logger.info(f"Successfully deleted entity S3 object: {s3_key}")
        except Exception as e:
            logger.warning(f"S3 object may not exist or already deleted: {s3_key} - {str(e)}")

        # Send message to SQS for cascade deletion of join relations
        send_cascade_deletion_message(entity_type, item.get('id'))

def handle_insert_update_operation(record, event_name, current_date, year, month, day):
    """Handle INSERT and MODIFY operations by creating/updating Parquet files"""
    image_data = record.get('dynamodb', {}).get('NewImage')
    if not image_data:
        return

    item = unmarshall_dynamodb_item(image_data)
    entity_type = item.get('entityType')

    if not entity_type:
        return

    # Add processing metadata
    item['_processing_timestamp'] = current_date.isoformat()
    item['_event_name'] = event_name
    item['_partition_year'] = year
    item['_partition_month'] = month
    item['_partition_day'] = day

    if item.get('joinTable'):
        handle_join_table_item(item, year, month, day, event_name)
    else:
        handle_regular_entity_item(item, entity_type, year, month, day, event_name)

def handle_join_table_item(item, year, month, day, event_name):
    """Handle join table items (many-to-many relationships) with date partitioning"""
    join_table = item['joinTable']
    pk_parts = item['PK'].split('#')
    sk_parts = item['SK'].split('#')

    key_components = pk_parts[2:] + sk_parts[2:]
    key_string = '_'.join(key_components)

    s3_key = f"tables/{join_table}/year={year}/month={month}/day={day}/{key_string}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{join_table}/"
    athena_table_name = join_table

    logger.info(f"Processing join table item for '{join_table}' - {event_name}")

    # Convert to DataFrame and write as Parquet
    df = create_dataframe_from_item(item)
    write_parquet_to_s3(df, s3_key)

    # Ensure Glue table exists with Parquet format
    ensure_optimized_glue_table(athena_table_name, table_location, item, df)

def handle_regular_entity_item(item, entity_type, year, month, day, event_name):
    """Handle regular entity items with date partitioning"""
    s3_key = f"tables/{entity_type}/year={year}/month={month}/day={day}/{item['id']}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{entity_type}/"
    athena_table_name = entity_type

    logger.info(f"Processing regular entity item for '{entity_type}' - {event_name}")

    # Convert to DataFrame and write as Parquet
    df = create_dataframe_from_item(item)
    write_parquet_to_s3(df, s3_key)

    # Ensure Glue table exists with Parquet format
    ensure_optimized_glue_table(athena_table_name, table_location, item, df)

def create_dataframe_from_item(item):
    """Convert DynamoDB item to pandas DataFrame with intelligent type optimization"""
    df = pd.DataFrame([item])

    # Optimize data types with proper timestamp handling
    for column in df.columns:
        if column.startswith('_partition_'):
            continue

        # Only handle timestamp fields if they are actual ISO 8601 timestamps (AWSDateTime)
        if (isinstance(df[column].iloc[0], str) and is_iso_timestamp(df[column].iloc[0])):
            try:
                # Convert ISO 8601 timestamp to pandas datetime with UTC timezone
                df[column] = pd.to_datetime(df[column], format='mixed', utc=True)
                logger.info(f"Converted AWSDateTime field '{column}' to datetime")
            except Exception as e:
                logger.warning(f"Failed to convert timestamp field '{column}': {e}")
                df[column] = df[column].astype('string')

        # Optimize numeric types
        elif df[column].dtype == 'object':
            try:
                numeric_series = pd.to_numeric(df[column], errors='ignore')
                if not numeric_series.equals(df[column]):
                    if numeric_series.dtype == 'int64':
                        df[column] = numeric_series.astype('int32')
                    elif numeric_series.dtype == 'float64':
                        df[column] = numeric_series.astype('float32')
                    else:
                        df[column] = numeric_series
                else:
                    df[column] = df[column].astype('string')
            except:
                df[column] = df[column].astype('string')

        # Convert other types to minimal representations
        elif df[column].dtype == 'int64':
            df[column] = df[column].astype('int32')
        elif df[column].dtype == 'float64':
            df[column] = df[column].astype('float32')

    return df

def is_iso_timestamp(value):
    """Check if a string value is an ISO 8601 timestamp"""
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except:
        return False

def write_parquet_to_s3(df, s3_key):
    """Write DataFrame as optimized Parquet to S3 with ultra-minimal schema"""
    try:
        # Convert DataFrame to PyArrow table
        table = pa.Table.from_pandas(df, preserve_index=False)

        # Create ultra-minimal schema for maximum compression
        ultra_minimal_schema = []
        for i, field in enumerate(table.schema):
            col_data = table.column(i).to_pylist()

            # Handle timestamp fields with native timestamp type
            if pd.api.types.is_datetime64_any_dtype(df.iloc[:, i]):
                minimal_field = pa.field(field.name, pa.timestamp('ns', tz='UTC'))
            elif all(isinstance(x, str) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.string())
            elif all(isinstance(x, bool) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.bool_())
            elif all(isinstance(x, int) or x is None for x in col_data):
                max_val = max((abs(x) for x in col_data if x is not None), default=0)
                if max_val < 128:
                    minimal_field = pa.field(field.name, pa.int8())
                elif max_val < 32768:
                    minimal_field = pa.field(field.name, pa.int16())
                else:
                    minimal_field = pa.field(field.name, pa.int32())
            elif all(isinstance(x, float) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.float32())
            else:
                minimal_field = pa.field(field.name, pa.string())

            ultra_minimal_schema.append(minimal_field)

        # Create table with ultra-minimal schema
        minimal_table = pa.table([table.column(i) for i in range(len(ultra_minimal_schema))],
                                schema=pa.schema(ultra_minimal_schema))

        # Write optimized Parquet with SNAPPY compression
        parquet_buffer = BytesIO()
        pq.write_table(
            minimal_table,
            parquet_buffer,
            compression='snappy',
            use_dictionary=False,
            write_statistics=False,
            version='2.6'
        )
        parquet_buffer.seek(0)

        # Upload to S3
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=parquet_buffer.getvalue(),
            ContentType='application/octet-stream'
        )

        parquet_size = len(parquet_buffer.getvalue())
        logger.info(f"Successfully wrote optimized Parquet: {s3_key} ({parquet_size} bytes)")

    except Exception as e:
        logger.error(f"Error writing Parquet to S3: {str(e)}")
        raise

def ensure_optimized_glue_table(table_name, location, sample_item, df):
    """Create or update Glue table with Parquet format and partition projection"""
    try:
        glue_client.get_table(DatabaseName=GLUE_DATABASE, Name=table_name)
        logger.info(f"Table '{table_name}' already exists")
        return
    except glue_client.exceptions.EntityNotFoundException:
        logger.info(f"Creating new Parquet table: {table_name}")
        create_parquet_glue_table(table_name, location, sample_item, df)

def create_parquet_glue_table(table_name, location, sample_item, df):
    """Create optimized Parquet Glue table with partition projection"""
    # Generate columns from DataFrame dtypes (more accurate than sample item)
    columns = []
    for column_name in df.columns:
        if column_name.startswith('_partition_'):
            continue

        column_type = infer_glue_type_from_dataframe(df, column_name)
        columns.append({
            'Name': column_name,
            'Type': column_type
        })

    # Add partition columns
    partition_keys = [
        {'Name': 'year', 'Type': 'string'},
        {'Name': 'month', 'Type': 'string'},
        {'Name': 'day', 'Type': 'string'}
    ]

    # Build storage template for partition projection
    storage_template = f"{location}year=${{year}}/month=${{month}}/day=${{day}}/"

    # Create Parquet table with partition projection
    glue_client.create_table(
        DatabaseName=GLUE_DATABASE,
        TableInput={
            'Name': table_name,
            'Description': f'Optimized Parquet table for {table_name} with SNAPPY compression',
            'PartitionKeys': partition_keys,
            'StorageDescriptor': {
                'Columns': columns,
                'Location': location,
                'InputFormat': 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                'OutputFormat': 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                'SerdeInfo': {
                    'SerializationLibrary': 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
                },
                'Parameters': {
                    'parquet.compression': 'SNAPPY',
                    'classification': 'parquet'
                }
            },
            'TableType': 'EXTERNAL_TABLE',
            'Parameters': {
                'EXTERNAL': 'TRUE',
                'parquet.compression': 'SNAPPY',
                'projection.enabled': 'true',
                'projection.year.type': 'integer',
                'projection.year.range': '2024,2030',
                'projection.month.type': 'integer',
                'projection.month.range': '1,12',
                'projection.month.digits': '2',
                'projection.day.type': 'integer',
                'projection.day.range': '1,31',
                'projection.day.digits': '2',
                'storage.location.template': storage_template,
                'has_encrypted_data': 'false',
                'typeOfData': 'file'
            }
        }
    )

    logger.info(f"Successfully created Parquet table '{table_name}' with partition projection")

def infer_glue_type_from_dataframe(df, column_name):
    """Infer Glue data type from DataFrame column dtype"""
    column_dtype = df[column_name].dtype

    if pd.api.types.is_datetime64_any_dtype(column_dtype):
        return 'timestamp'
    elif pd.api.types.is_bool_dtype(column_dtype):
        return 'boolean'
    elif pd.api.types.is_integer_dtype(column_dtype):
        return 'bigint'
    elif pd.api.types.is_float_dtype(column_dtype):
        return 'double'
    elif pd.api.types.is_string_dtype(column_dtype) or column_dtype == 'object':
        return 'string'
    else:
        return 'string'

def unmarshall_dynamodb_item(dynamodb_item):
    """Convert DynamoDB item format to regular Python dict"""
    item = {}
    for key, value in dynamodb_item.items():
        if 'S' in value:
            item[key] = value['S']
        elif 'N' in value:
            item[key] = float(value['N']) if '.' in value['N'] else int(value['N'])
        elif 'BOOL' in value:
            item[key] = value['BOOL']
        elif 'L' in value:
            item[key] = [unmarshall_value(v) for v in value['L']]
        elif 'M' in value:
            item[key] = {k: unmarshall_value(v) for k, v in value['M'].items()}
        elif 'NULL' in value:
            item[key] = None
        else:
            item[key] = str(value)
    return item

def unmarshall_value(value):
    """Unmarshall a single DynamoDB value"""
    if 'S' in value:
        return value['S']
    elif 'N' in value:
        return float(value['N']) if '.' in value['N'] else int(value['N'])
    elif 'BOOL' in value:
        return value['BOOL']
    elif 'NULL' in value:
        return None
    else:
        return str(value)

def parse_item_date(date_string, default_date):
    """Parse date string or return default"""
    if not date_string:
        return default_date
    try:
        return datetime.fromisoformat(date_string.replace('Z', '+00:00'))
    except:
        return default_date

def format_date_parts(date_obj):
    """Format date into year, month, day parts"""
    return (
        date_obj.strftime('%Y'),
        date_obj.strftime('%m'),
        date_obj.strftime('%d')
    )
```

**Key Features:**

- **Full CRUD Support**: Handles INSERT, MODIFY, and REMOVE operations
- **Join Table Support**: Automatically handles many-to-many relationship tables
- **Intelligent Type Detection**: Converts ISO 8601 timestamps to native datetime, optimizes numeric types
- **Automatic Glue Table Creation**: Creates Parquet tables with partition projection for optimal query performance
- **Date Partitioning**: Organizes data by year/month/day for efficient query pruning
- **Ultra-Minimal Parquet Schema**: Uses smallest possible data types for maximum compression
- **Error Resilience**: Continues processing other records if one fails
- **Cascade Deletion**: Sends SQS messages for entity deletions to trigger join table cleanup

### 7. Cascade Deletion Listener (Node.js 18.x)

SQS queue listener that automatically cleans up join table relations and S3 files when entities are deleted.

### 10. Deletion Listener (Node.js 18.x)

Processes deletion tasks for DELETE SQL operations. Retrieves query results from Athena and deletes S3 Parquet files.

```javascript
// Pattern: OCG-{project}-cascade-deletion-listener (no hash - created once per project)
// Example: OCG-blog-cascade-deletion-listener

const {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { S3Client, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

exports.handler = async (event) => {
  // Process SQS messages for cascade deletion
  for (const record of event.Records) {
    const { entityType, entityId } = JSON.parse(record.body);

    // Query all joinRelation items for this entity
    const pk = `joinRelation#${entityType}#${entityId}`;
    const queryResult = await dynamoClient.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: "PK = :pk",
        ExpressionAttributeValues: { ":pk": { S: pk } },
      })
    );

    // Collect S3 keys to delete
    const s3KeysToDelete = [];
    const joinRelationItems = [];

    for (const item of queryResult.Items) {
      const unmarshalled = unmarshall(item);
      joinRelationItems.push(unmarshalled);
      if (unmarshalled.s3Key) {
        s3KeysToDelete.push({ Key: unmarshalled.s3Key });
      }
    }

    // Bulk delete S3 objects (max 1000 per request)
    if (s3KeysToDelete.length > 0) {
      const chunks = [];
      for (let i = 0; i < s3KeysToDelete.length; i += 1000) {
        chunks.push(s3KeysToDelete.slice(i, i + 1000));
      }

      for (const chunk of chunks) {
        await s3Client.send(
          new DeleteObjectsCommand({
            Bucket: BUCKET_NAME,
            Delete: { Objects: chunk },
          })
        );
      }
    }

    // Delete joinRelation items from DynamoDB
    for (const item of joinRelationItems) {
      await dynamoClient.send(
        new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: { PK: { S: item.PK }, SK: { S: item.SK } },
        })
      );
    }
  }
};
```

**Key Features:**

- **SQS Integration**: Listens to cascade deletion queue for entity deletion events
- **Bulk S3 Deletion**: Efficiently deletes up to 1000 S3 objects per request
- **Automatic Cleanup**: Removes both S3 Parquet files and DynamoDB joinRelation items
- **Error Resilience**: Continues processing even if individual deletions fail

### 10. Deletion Listener (Node.js 18.x)

Processes deletion tasks for DELETE SQL operations. Retrieves query results from Athena and performs complete cleanup of both DynamoDB items and S3 Parquet files.

```javascript
// Pattern: OCG-{project}-deletion-listener (no hash - created once per project)
// Example: OCG-blog-deletion-listener

const {
  AthenaClient,
  GetQueryResultsCommand,
} = require("@aws-sdk/client-athena");
const { S3Client, DeleteObjectsCommand } = require("@aws-sdk/client-s3");
const {
  DynamoDBClient,
  QueryCommand,
  DeleteItemCommand,
} = require("@aws-sdk/client-dynamodb");

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  // Process SQS messages from deletion queue
  for (const record of event.Records) {
    const { executionId } = JSON.parse(record.body);

    // Get query results from Athena (contains both s3Key and relationId)
    const result = await athenaClient.send(
      new GetQueryResultsCommand({
        QueryExecutionId: executionId,
        MaxResults: 1000,
      })
    );

    // Extract s3Key and relationId values from results
    const deletionItems = []; // Array of { s3Key, relationId }
    const rows = result.ResultSet?.Rows || [];
    if (rows.length > 0) {
      const headers = rows[0].Data?.map((col) => col.VarCharValue) || [];
      const s3KeyIndex = headers.findIndex(
        (h) => h && h.toLowerCase() === "s3key"
      );
      const relationIdIndex = headers.findIndex(
        (h) => h && h.toLowerCase() === "relationid"
      );

      for (let i = 1; i < rows.length; i++) {
        const s3KeyValue = rows[i].Data?.[s3KeyIndex]?.VarCharValue;
        const relationIdValue = rows[i].Data?.[relationIdIndex]?.VarCharValue;
        if (s3KeyValue && relationIdValue) {
          deletionItems.push({ s3Key: s3KeyValue, relationId: relationIdValue });
        }
      }
    }

    // Process each deletion item
    for (const item of deletionItems) {
      // 1. Delete joinTableData#{relationId} item
      await dynamoClient.send(
        new DeleteItemCommand({
          TableName: TABLE_NAME,
          Key: {
            PK: { S: \`joinTableData#\${item.relationId}\` },
            SK: { S: \`joinTableData#\${item.relationId}\` },
          },
        })
      );

      // 2. Query GSI1 to find all joinRelation items for this relationId
      const gsi1Result = await dynamoClient.send(
        new QueryCommand({
          TableName: TABLE_NAME,
          IndexName: "GSI1",
          KeyConditionExpression: "#gsi1Pk = :gsi1Pk",
          ExpressionAttributeNames: {
            "#gsi1Pk": "GSI1-PK",
          },
          ExpressionAttributeValues: {
            ":gsi1Pk": { S: \`joinRelation#\${item.relationId}\` },
          },
        })
      );

      // 3. Delete all joinRelation items found
      if (gsi1Result.Items && gsi1Result.Items.length > 0) {
        for (const joinRelationItem of gsi1Result.Items) {
          const pk = joinRelationItem.PK?.S;
          const sk = joinRelationItem.SK?.S;
          if (pk && sk) {
            await dynamoClient.send(
              new DeleteItemCommand({
                TableName: TABLE_NAME,
                Key: {
                  PK: { S: pk },
                  SK: { S: sk },
                },
              })
            );
          }
        }
      }

      // 4. Delete S3 Parquet file
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: {
            Objects: [{ Key: item.s3Key }],
            Quiet: false,
          },
        })
      );
    }
  }
};
```

**Key Features:**

- **SQS Integration**: Listens to deletion queue for completed DELETE task executions
- **Athena Results**: Retrieves query results containing both `s3Key` and `relationId` values
- **Complete Cleanup**: Deletes both DynamoDB items (`joinTableData` and `joinRelation`) and S3 Parquet files
- **GSI1 Query**: Uses GSI1 to efficiently find all `joinRelation` items for each `relationId`
- **Error Resilience**: Continues processing even if individual deletions fail

**How Cascade Deletion Works:**

1. **Entity Deletion**: When a regular entity (e.g., `User`) is deleted, the stream processor detects the `REMOVE` event
2. **SQS Message**: Stream processor sends a message to the cascade deletion queue with `{entityType, entityId}`
3. **Queue Processing**: Cascade deletion listener receives the message
4. **Query Relations**: Queries DynamoDB for all `joinRelation` items with `PK: joinRelation#<entityType>#<entityId>` and `SK` starting with `joinRelation#`
5. **GSI1 Query**: For each found `relationId`, queries GSI1 (`GSI1-PK: joinRelation#<relationId>`) to find all related entities
6. **Bulk Delete**: Deletes all related S3 Parquet files using bulk delete operations
7. **Cleanup**: Removes all `joinRelation` items from DynamoDB
8. **Cleanup Temporary Items**: Deletes all `joinTableData#<relationId>` items associated with the deleted relations

This ensures that when you delete a `User`, all related join table entries (like `user_favorite_products`) and their S3 files are automatically cleaned up, even when multiple entity types are involved in the same join table.

**Join Table Duplicate Prevention:**

- The framework uses **deterministic relation IDs** to prevent duplicate inserts
- Relation IDs are generated by:
  1. Including the table name to prevent collisions across different join tables
  2. Sorting entity mappings alphabetically by entity type and value
  3. Creating a string: `tableName|entityType1:value1|entityType2:value2|...`
  4. Hashing with SHA-256 and taking the first 32 characters
- Before creating a new relation, the system checks if `joinTableData#<relationId>` already exists
- If it exists, returns the existing relation data (prevents duplicate Parquet files and DynamoDB items)
- If it doesn't exist, creates a new relation with conditional put to handle race conditions

**Automatic Cleanup of Temporary Items:**

- The stream processor automatically deletes `joinTableData#<relationId>` items after processing
- This happens synchronously after writing the Parquet file to S3
- Uses conditional delete to prevent race conditions
- If deletion fails, it's logged but doesn't block processing (the Parquet file is already written)

**DELETE SQL Operations:**

The framework supports DELETE SQL operations through asynchronous deletion tasks:

1. **Query Transformation**: DELETE queries **must use `$join_table()` wrapper** for table names (similar to INSERT queries). The wrapper is automatically removed before execution, then the query is transformed to a SELECT query that returns both `s3Key` and `relationId` values
   - Example: `DELETE ufp FROM $join_table(user_favorite_products) ufp ...` → `DELETE ufp FROM user_favorite_products ufp ...` → `SELECT ufp.s3Key, ufp.relationId FROM user_favorite_products ufp ...`
2. **Task Creation**: A task entity is created with `taskType: "deletionTask"`
3. **Async Execution**: The SELECT query is executed via Athena
4. **EventBridge Tracking**: Execution tracker monitors query status
5. **Queue Publishing**: When query succeeds, execution ID is published to deletion queue
6. **Complete Deletion**: Deletion listener retrieves results from Athena and performs complete cleanup:
   - Deletes `joinTableData#{relationId}` items from DynamoDB
   - Queries GSI1 (`GSI1-PK: joinRelation#{relationId}`) to find all `joinRelation` items
   - Deletes all `joinRelation` items from DynamoDB
   - Deletes S3 Parquet files

**Example DELETE Mutation:**

```graphql
type Mutation {
  removeBrandFromFavorites(brandId: ID!): Boolean
    @sql_query(
      query: "DELETE ufp FROM user_favorite_products ufp INNER JOIN products p ON ufp.productId = p.productId WHERE p.brandId = $args.brandId;"
    )
}
```

This automatically generates:

- `triggerTaskRemoveBrandFromFavorites(brandId: ID!): TaskTriggerResult!`
- `taskResultRemoveBrandFromFavorites(taskId: ID!): DeletionTaskResult!`

**Join Relation Item Structure:**

```javascript
{
  PK: "joinRelation#user#123",
  SK: "joinRelation#abc-123-def-456",
  "GSI1-PK": "joinRelation#abc-123-def-456",
  "GSI1-SK": "joinRelation#user#123",
  entityType: "joinRelation",
  relationId: "abc-123-def-456",
  joinTableName: "user_favorite_products",
  relatedEntityType: "user",
  relatedEntityId: "123",
  s3Key: "tables/user_favorite_products/year=2025/month=12/day=05/abc-123-def-456.parquet",
  createdAt: "2025-12-05T10:00:00Z"
}
```

## ⚙️ Function Configuration

### Runtime & Memory Allocation

| **Function Type**         | **Runtime**  | **Memory** | **Timeout** | **Concurrency** |
| ------------------------- | ------------ | ---------- | ----------- | --------------- |
| CRUD Operations           | Node.js 18.x | 128 MB     | 30 seconds  | 1000            |
| SQL Queries               | Node.js 18.x | 256 MB     | 5 minutes   | 100             |
| Task Mutations            | Node.js 18.x | 256 MB     | 30 seconds  | 100             |
| Task Result Queries       | Node.js 18.x | 256 MB     | 30 seconds  | 100             |
| Execution Tracker         | Node.js 18.x | 256 MB     | 5 minutes   | 100             |
| Resolvers                 | Node.js 18.x | 512 MB     | 5 minutes   | 100             |
| Stream Processor          | Python 3.11  | 1024 MB    | 5 minutes   | 10              |
| Cascade Deletion Listener | Node.js 18.x | 512 MB     | 5 minutes   | 10              |
| Deletion Listener         | Node.js 18.x | 512 MB     | 5 minutes   | 10              |

### Environment Variables

All functions receive these environment variables:

```bash
DYNAMODB_TABLE_NAME=OCG-{project}
S3_BUCKET_NAME=ocg-{project}-{account-id}
ATHENA_DATABASE_NAME={project}_db
ATHENA_OUTPUT_LOCATION=s3://ocg-{project}-athena-results-{account-id}/query-results/
CASCADE_DELETION_QUEUE_URL=https://sqs.{region}.amazonaws.com/{account}/{project}-cascade-deletion
AWS_REGION={region}
```

### IAM Permissions

#### CRUD Functions

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem"
  ],
  "Resource": "arn:aws:dynamodb:{region}:{account}:table/{project}"
}
```

#### Query/Mutation Functions

```json
{
  "Effect": "Allow",
  "Action": [
    "athena:StartQueryExecution",
    "athena:GetQueryExecution",
    "athena:GetQueryResults",
    "glue:GetTable",
    "glue:GetDatabase"
  ],
  "Resource": "*"
}
```

#### Stream Processor

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:GetObject",
    "glue:CreateTable",
    "glue:GetTable",
    "sqs:SendMessage"
  ],
  "Resource": [
    "arn:aws:s3:::{project}-{account}/*",
    "arn:aws:glue:{region}:{account}:*",
    "arn:aws:sqs:{region}:{account}:{project}-cascade-deletion"
  ]
}
```

#### Cascade Deletion Listener

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:Query",
    "dynamodb:DeleteItem",
    "s3:DeleteObject",
    "s3:DeleteObjects"
  ],
  "Resource": [
    "arn:aws:dynamodb:{region}:{account}:table/{project}",
    "arn:aws:s3:::{project}-{account}/*"
  ]
}
```

#### Deletion Listener

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:Query",
    "dynamodb:DeleteItem",
    "athena:GetQueryResults",
    "s3:DeleteObject",
    "s3:DeleteObjects"
  ],
  "Resource": [
    "arn:aws:dynamodb:{region}:{account}:table/{project}",
    "arn:aws:s3:::{project}-{account}/*",
    "arn:aws:athena:{region}:{account}:*"
  ]
}
```

## 🚀 Performance Optimization

### Cold Start Mitigation

```javascript
// Connection reuse across invocations
const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  retryMode: "adaptive",
});

// Optimize SDK imports
const { GetItemCommand } = require("@aws-sdk/client-dynamodb");
```

### Memory Optimization

```javascript
// Efficient data processing
exports.handler = async (event) => {
  try {
    const result = await processEvent(event);
    return result;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    // Cleanup resources if needed
  }
};
```

### Parallel Execution

```javascript
// Resolver functions execute queries in parallel
const queryPromises = [
  executeQuery(query1, params),
  executeQuery(query2, params),
  executeQuery(query3, params),
];

const results = await Promise.all(queryPromises);
```

## 📊 Monitoring & Debugging

### CloudWatch Metrics

- **Duration**: Function execution time
- **Errors**: Error count and rate
- **Throttles**: Concurrency limit hits
- **Cold Starts**: First-time execution delays

### Logging Strategy

```javascript
exports.handler = async (event) => {
  console.log("Function started:", JSON.stringify(event, null, 2));

  try {
    const result = await processEvent(event);
    console.log("Function completed successfully");
    return result;
  } catch (error) {
    console.error("Function failed:", error);
    throw error;
  }
};
```

### X-Ray Tracing

```javascript
const AWSXRay = require("aws-xray-sdk-core");
const AWS = AWSXRay.captureAWS(require("aws-sdk"));

// Automatic distributed tracing across all services
```

## 🔧 Custom Function Patterns

### Error Handling

```javascript
exports.handler = async (event) => {
  try {
    // Validate input
    if (!event.arguments?.id) {
      throw new Error("Missing required argument: id");
    }

    // Execute operation
    const result = await performOperation(event.arguments);

    return result;
  } catch (error) {
    console.error("Error processing request:", error);

    if (error.message.includes("not found")) {
      throw new Error("Resource not found");
    } else if (error.message.includes("validation")) {
      throw new Error("Invalid input parameters");
    } else {
      throw new Error("Internal server error");
    }
  }
};
```

### Caching Strategy

```javascript
const cache = new Map();

exports.handler = async (event) => {
  const cacheKey = JSON.stringify(event.arguments);

  // Check cache first
  if (cache.has(cacheKey)) {
    console.log("Cache hit");
    return cache.get(cacheKey);
  }

  // Execute query
  const result = await executeQuery(event);

  // Cache result (with TTL)
  cache.set(cacheKey, result);
  setTimeout(() => cache.delete(cacheKey), 300000); // 5 minutes

  return result;
};
```

## 📈 Scaling Considerations

### Concurrency Limits

- **CRUD Operations**: High concurrency (1000+) for fast operations
- **Analytics Queries**: Lower concurrency (100) for resource-intensive operations
- **Stream Processor**: Controlled concurrency (10) for stable data processing

### Cost Optimization

- **Right-sized Memory**: Minimize memory allocation for faster cold starts
- **Efficient Code**: Minimize dependencies and optimize data processing
- **Connection Reuse**: Leverage connection pooling across invocations

---

This comprehensive function architecture provides scalable, efficient, and maintainable serverless GraphQL operations while maintaining optimal performance and cost characteristics.
