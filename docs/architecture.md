# Architecture Overview

OC-GraphQL is a serverless-first architecture designed for scalability, performance, and cost-effectiveness. This document explains the complete system design and component relationships.

## 🏗️ High-Level Architecture

```
┌─────────────────┐    ┌──────────────┐    ┌─────────────────┐
│   GraphQL API   │────│   Lambda     │────│   DynamoDB      │
│   (AppSync)     │    │  Functions   │    │    Table + GSI1  │
└─────────────────┘    └──────────────┘    └─────────────────┘
                              │                       │
                              │                       │
                              ▼                       ▼
                    ┌──────────────┐         ┌─────────────────┐
                    │   Athena     │◄────────│  DynamoDB       │
                    │   Tables     │         │   Streams       │
                    └──────────────┘         └─────────────────┘
                              │                       │
                              │                       │
                              ▼                       ▼
                    ┌──────────────┐         ┌─────────────────┐
                    │  S3 Parquet  │◄────────│  Python Stream  │
                    │  Data Lake   │         │   Processor     │
                    └──────────────┘         └─────────────────┘
                              │                       │
                              │                       │
                    ┌──────────────┐         ┌─────────────────┐
                    │  EventBridge │         │   SQS Queues    │
                    │  (Athena     │         │  (Cascade &     │
                    │   Events)    │         │   Deletion)     │
                    └──────────────┘         └─────────────────┘
```

## 🔄 Data Flow Architecture

### 1. **Request Processing Layer**

```
Client Request → AppSync → Lambda Resolver → DynamoDB
                      ↓
                 Custom Logic (SQL Queries via Athena)
```

**Components:**

- **AppSync GraphQL API**: Entry point for all GraphQL operations
- **Lambda Resolvers**: Business logic and data processing
- **DynamoDB**: Primary operational data store

### 2. **Analytics Processing Layer**

```
DynamoDB → Streams → Python Processor → Parquet Files → Athena Tables
                                     ↓
                              Schema-Based Type Enforcement
                                     ↓
                              SNAPPY Compression
```

**Components:**

- **DynamoDB Streams**: Real-time change capture (NEW_AND_OLD_IMAGES)
- **Python Stream Processor**: Parquet conversion with GraphQL schema type enforcement
- **S3 Parquet Storage**: Columnar analytics storage with date partitioning
- **Glue Tables**: Created during CDK deployment via Custom Resource Lambda with partition projection
- **SQS Queues**: Cascade deletion and deletion task processing
- **EventBridge**: Athena query state change events for task tracking

## 📊 Component Deep Dive

### GraphQL Layer (AppSync)

**Purpose**: API Gateway and GraphQL execution engine

**Features:**

- Automatic CRUD operations generation
- Task-based query execution (all Query fields are automatically tasks)
- API key authentication
- Asynchronous query execution via EventBridge and polling fallback

**Generated Resolvers:**

```typescript
// Auto-generated for each entity type
Query.readUser → Lambda → DynamoDB.GetItem
Mutation.createUser → Lambda → DynamoDB.PutItem
Mutation.triggerTaskGetUsersByCity → Lambda → Athena.StartQueryExecution
Query.taskResultGetUsersByCity → Lambda → Athena.GetQueryResults
```

### Lambda Functions Architecture

**Function Types & Patterns:**

#### 1. **CRUD Functions** (Node.js 18.x)

```
Pattern: OCG-{project}-{operation}-{entity}
Examples:
- OCG-blog-create-user
- OCG-blog-read-post
- OCG-blog-update-comment
```

#### 2. **Task Trigger Mutations** (Node.js 18.x)

```
Pattern: OCG-{project}-{hash} (hash from: {project}-mutation-triggerTask{QueryName})
Examples:
- OCG-blog-{hash} (for blog-mutation-triggerTaskGetUsersByCity)
```

#### 3. **Task Result Queries** (Node.js 18.x)

```
Pattern: OCG-{project}-{hash} (hash from: {project}-query-taskResult{QueryName})
Examples:
- OCG-blog-{hash} (for blog-query-taskResultGetUsersByCity)
```

#### 4. **Stream Processor** (Python 3.11)

```
Pattern: OCG-{project}-stream-processor
Example: OCG-blog-stream-processor
```

#### 5. **Athena Execution Tracker** (Node.js 18.x)

```
Pattern: OCG-{project}-athena-execution-tracker
Example: OCG-blog-athena-execution-tracker
```

#### 6. **Cascade Deletion Listener** (Node.js 18.x)

```
Pattern: OCG-{project}-cascade-deletion-listener
Example: OCG-blog-cascade-deletion-listener
```

#### 7. **Deletion Listener** (Node.js 18.x)

```
Pattern: OCG-{project}-deletion-listener
Example: OCG-blog-deletion-listener
```

### Data Storage Architecture

#### Primary Storage (DynamoDB)

**Table Design:**

- **Single Table Pattern**: One table per project (`OCG-{project}`)
- **Composite Keys**:
  - `PK`: Primary identifier
  - `SK`: Sort key for relationships
- **Global Secondary Index (GSI1)**:
  - `GSI1-PK`: `joinRelation#relationId` (for querying all entities in a relation)
  - `GSI1-SK`: `joinRelation#entityType#entityId` (for querying specific entity relations)
- **Stream Configuration**: NEW_AND_OLD_IMAGES

**Key Patterns:**

```
Regular Entities:
PK: "entity#id", SK: "entity#id"
Example: PK: "user#123", SK: "user#123"

Task Entities (Metadata):
PK: "task#executionId", SK: "task#executionId"
Example: PK: "task#abc-123-def", SK: "task#abc-123-def"

Join Relation Items (Metadata):
PK: "joinRelation#entityType#entityId", SK: "joinRelation#relationId"
GSI1-PK: "joinRelation#relationId", GSI1-SK: "joinRelation#entityType#entityId"
Example: PK: "joinRelation#user#123", SK: "joinRelation#abc-123-def-456"
       GSI1-PK: "joinRelation#abc-123-def-456", GSI1-SK: "joinRelation#user#123"

Temporary Join Table Data Items:
PK: "joinTableData#relationId", SK: "joinTableData#relationId"
Example: PK: "joinTableData#abc-123-def-456", SK: "joinTableData#abc-123-def-456"
```

#### Analytics Storage (S3 Parquet)

**Storage Structure:**

```
s3://ocg-{project}-{account-id}/
├── tables/
│   ├── user/
│   │   └── year=2024/month=12/day=15/
│   │       ├── {user-id-1}.parquet
│   │       └── {user-id-2}.parquet
│   ├── post/
│   │   └── year=2024/month=12/day=15/
│   │       └── {post-id}.parquet
│   └── user_favorite_products/  # Join table
│       └── year=2024/month=12/day=15/
│           └── {relationId}.parquet  # Deterministic hash-based relationId
└── athena-results/
    └── query-results/
```

**Key Points:**

- Regular entities use their `id` as the Parquet filename
- Join tables use deterministic `relationId` (32-char hash) as the filename
- Partitioning uses `createdAt` date to ensure updates go to the same partition
- All bucket names are lowercase (AWS requirement)

**Parquet Optimization:**

- **Format**: Columnar Parquet with SNAPPY compression
- **Compression Ratio**: 90-98% size reduction vs JSON
- **Type Optimization**:
  - Timestamps → `timestamp(ns, tz=UTC)`
  - Numbers → `int8/int16/int32` or `float32`
  - Strings → Dictionary encoded
  - Booleans → Bit-packed

### Stream Processing Architecture

**Python-Based Processor Features:**

#### Real-time Processing

```python
DynamoDB Stream Event → Python Lambda → Schema-Based Type Enforcement → Parquet Processing → S3 Upload
                                                      ↓
                                          GraphQL Schema Types (SCHEMA_MAPPING)
                                                      ↓
                                          Correct Parquet Column Types
```

#### Processing Logic

1. **Event Detection**: INSERT, MODIFY, REMOVE operations from DynamoDB Streams
2. **Entity Filtering**:
   - Skips task entities (metadata only, stored in DynamoDB)
   - Skips temporary `joinTableData` items (deleted after processing)
   - Skips `joinRelation` metadata items (handled by cascade deletion)
3. **Data Transformation**: DynamoDB → pandas DataFrame with schema-based type enforcement
4. **Type Enforcement**: Uses GraphQL schema types (`SCHEMA_MAPPING` and `JOIN_TABLE_SCHEMAS`) to ensure correct Parquet column types
5. **Parquet Generation**: PyArrow with SNAPPY compression and minimal schema
6. **S3 Upload**: Partitioned storage using `createdAt` date for consistency (updates go to original partition)
7. **Automatic Cleanup**: Deletes temporary `joinTableData` items synchronously after Parquet write
8. **Cascade Deletion**: Sends SQS messages for entity deletions to trigger join table cleanup

#### Supported Operations

```python
CREATE: item → df → parquet → s3
UPDATE: item → df → parquet → s3 (same partition as creation)
DELETE: item → s3.delete(parquet_file) → sqs.send(cascade_deletion_message)
```

## 🔧 Infrastructure Components

### AWS Services Used

#### Core Services

- **AWS AppSync**: GraphQL API management
- **AWS Lambda**: Serverless compute (Node.js + Python)
- **Amazon DynamoDB**: Primary database with streams and GSI1 for join relations
- **Amazon S3**: Data lake storage (Parquet files)
- **AWS Glue**: Data catalog and metadata (tables created during deployment)
- **Amazon Athena**: Analytics query engine
- **Amazon EventBridge**: Athena query state change events for task tracking
- **Amazon SQS**: Queue service for cascade deletion and deletion tasks

#### Supporting Services

- **AWS IAM**: Access control and permissions
- **Amazon CloudWatch**: Monitoring and logging
- **AWS CloudFormation**: Infrastructure as code
- **AWS CDK**: Infrastructure deployment tool

## 🚀 Scalability & Performance

### Auto-Scaling Components

#### DynamoDB

- **Billing Mode**: Pay-per-request (auto-scaling)
- **Stream Configuration**: Automatic shard management
- **Backup**: Point-in-time recovery

#### Lambda Functions

- **Concurrency**: Automatic scaling (up to account limits)
- **Memory**: 1024MB (all functions)
- **Timeout**: 30s (CRUD/Tasks) to 15 minutes (Stream Processor, Deletion Listeners)

#### S3 Storage

- **Partitioning**: Date-based automatic partitioning
- **Compression**: SNAPPY for optimal query performance
