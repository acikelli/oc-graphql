# OC-GraphQL

**A serverless GraphQL framework for AWS** - Automatically generate and deploy production-ready GraphQL APIs with advanced analytics capabilities.

OC-GraphQL is a framework that abstracts AWS infrastructure complexity, automatically generating and deploying complete serverless GraphQL applications. Transform your GraphQL schema into a production-ready infrastructure with real-time data analytics powered by Apache Parquet storage for 90-98% cost reduction and 50-100x faster queries, all with a single command.

## Key Features

### **Automatic CRUD Generation**

- Zero-config database operations for all GraphQL types
- Single-table DynamoDB design with optimized key structure
- Auto-generated Lambda functions with built-in security

### **SQL-First Analytics**

- Direct SQL queries in GraphQL with `@sql_query` directive
- Complex joins and aggregations via Amazon Athena
- Join tables for many-to-many relationships

### **Advanced Data Pipeline**

- **Real-time Processing**: DynamoDB Streams → Python Processor → Parquet S3
- **Native Parquet Storage**: Apache Parquet with SNAPPY compression for optimal performance
- **Intelligent Type Detection**: Automatic timestamp, numeric, and string optimization
- **Date Partitioning**: Automatic year/month/day partitioning for optimal query performance
- **Cost Optimization**: 90-98% storage reduction and 99% query cost reduction

### **Security**

- Built-in SQL injection protection with automatic parameter sanitization
- IAM role-based access control with least privilege principle

### **Performance & Cost **

- **Storage**: 90-98% smaller files vs traditional JSON approaches
- **Query Speed**: 50-100x faster analytics with columnar Parquet format
- **Query Cost**: 99% cost reduction through partition pruning and column pruning
- **Compute**: Right-sized Lambda functions with optimized memory allocation

## Comprehensive Documentation

### 📖 **[Complete Documentation](./docs/README.md)**

- **[Architecture Overview](./docs/architecture.md)** - System design and component relationships
- **[Naming Conventions](./docs/naming-conventions.md)** - Resource naming patterns and standards
- **[Storage Format](./docs/storage-format.md)** - Parquet optimization and compression strategies
- **[Schema Design](./docs/schema-design.md)** - GraphQL patterns and custom directives
- **[Lambda Functions](./docs/lambda-functions.md)** - Generated function types and patterns
- **[Security Features](./docs/security.md)** - SQL injection protection and access control

## 🚀 Quick Start

### Installation

```bash
npm install -g oc-graphql
```

### Deploy in Seconds

```bash
# 1. Create your GraphQL schema
cat > schema.graphql << 'EOF'
type User {
  id: ID!
  name: String!
  email: String!
  age: Int
  posts: [Post!]! @sql_query(query: "SELECT * FROM post WHERE user_id = $source.id")
}

type Post {
  id: ID!
  title: String!
  content: String!
  userId: ID!
  likeCount: Int! @sql_query(query: "SELECT COUNT(*) as count FROM post_likes WHERE post_id = $source.id")
}

type Query {
  getTrendingPosts(days: Int = 7): [Post!]! @sql_query(query: """
    SELECT p.*, COUNT(pl.id) as likes
    FROM post p
    LEFT JOIN post_likes pl ON p.id = pl.post_id
    WHERE p.created_at >= current_date - interval '$args.days' day
    GROUP BY p.id
    ORDER BY likes DESC
    LIMIT 10
  """)
}
EOF

# 2. Deploy to AWS
oc-graphql deploy -n my-api -f schema.graphql

# 3. Start querying your API!
# GraphQL endpoint will be displayed after deployment
```

## 🔧 Architecture Highlights

### Data Flow

```
GraphQL Request → AppSync → Lambda Resolvers → DynamoDB (operational)
                                          ↓
                     Real-time Analytics ← Athena ← Parquet S3 ← Python Processor ← DynamoDB Streams
```

### Generated Infrastructure

The framework automatically generates and deploys:

- **AppSync GraphQL API** with auto-generated resolvers and API key authentication
- **Lambda Functions** (5-20+ functions depending on schema complexity) with optimized runtime and memory allocation
- **DynamoDB Table** with optimized single-table design and DynamoDB Streams enabled
- **S3 Data Lake** with Parquet storage, date partitioning, and automatic Glue table creation
- **Athena Tables** with partition projection for ultra-fast queries
- **IAM Roles** with least-privilege security policies
- **CloudWatch Logs** for comprehensive monitoring and debugging

### Function Types Generated

| **Function Type**   | **Count**                      | **Runtime**  | **Memory** | **Timeout** | **Purpose**               | **Example**                          |
| ------------------- | ------------------------------ | ------------ | ---------- | ----------- | ------------------------- | ------------------------------------ |
| CRUD Operations     | 4 per entity                   | Node.js 18.x | 128 MB     | 30 seconds  | Basic database operations | `OCG-api-create-user`                |
| SQL Queries         | 1 per @sql_query               | Node.js 18.x | 256 MB     | 5 minutes   | Custom analytics          | `OCG-api-query-getTrendingPosts`     |
| Task Mutations      | 1 per @task query              | Node.js 18.x | 256 MB     | 30 seconds  | Trigger async tasks       | `OCG-api-mutation-triggerTaskReport` |
| Task Result Queries | 1 per @task query              | Node.js 18.x | 256 MB     | 30 seconds  | Poll task results         | `OCG-api-query-taskResultReport`     |
| Execution Tracker   | 1 per project (if tasks exist) | Node.js 18.x | 256 MB     | 5 minutes   | Track Athena executions   | `OCG-api-athena-execution-tracker`   |
| Resolvers           | 1 per @resolver type           | Node.js 18.x | 512 MB     | 5 minutes   | Complex type resolution   | `OCG-api-resolver-postconnection`    |
| Field Resolvers     | 1 per @sql_query field         | Node.js 18.x | 256 MB     | 5 minutes   | Individual field queries  | `OCG-api-field-user-totalPosts`      |
| Stream Processor    | 1 per project                  | Python 3.11  | 1024 MB    | 5 minutes   | Real-time data pipeline   | `OCG-api-stream-processor`           |

**Function Naming Pattern**: `OCG-{project}-{category}-{identifier}`

All functions are automatically configured with:

- Environment variables for DynamoDB, S3, Athena, and Glue access
- IAM roles with least-privilege permissions
- Connection reuse and retry logic for optimal performance
- Comprehensive error handling and logging

### Query Performance Examples

#### Before (JSON Lines)

```sql
-- Scans 1TB, takes 30-60 seconds, costs $5
SELECT name FROM user WHERE year = '2024';
```

#### After (Parquet)

```sql
-- Scans 10GB (column pruning + partition pruning), takes 1-3 seconds, costs $0.05
SELECT name FROM user WHERE year = '2024';
```

## Custom Directives

### `@sql_query` - Direct SQL Integration

```graphql
type Query {
  searchUsers(name: String!, city: String): [User!]!
    @sql_query(
      query: """
      SELECT * FROM user
      WHERE name ILIKE '%$args.name%'
        AND ($args.city IS NULL OR city = $args.city)
      ORDER BY name
      """
    )
}
```

### `@resolver` - Custom Types

```graphql
type UserAnalytics @resolver {
  totalPosts: Int!
    @sql_query(
      query: "SELECT COUNT(*) as count FROM post WHERE user_id = $source.id"
    )
  avgEngagement: Float!
    @sql_query(
      query: "SELECT AVG(like_count) FROM post WHERE user_id = $source.id"
    )
  topTags: [String!]!
    @sql_query(
      query: "SELECT tag FROM post_tags WHERE user_id = $source.id GROUP BY tag ORDER BY COUNT(*) DESC LIMIT 5"
    )
}
```

### `@task` - Long-Running Query Tasks

Handle queries that may exceed AppSync's 30-second timeout by executing them asynchronously.

**Requirements:**

- `@task` can only be used on `Query` fields (not `Mutation`)
- The return type must have the `@task_response` directive
- Types with `@task_response` do not generate CRUD operations

```graphql
type Query {
  generateYearlyReport(year: Int!): [ReportData!]!
    @sql_query(
      query: """
      SELECT month, COUNT(*) as orders, SUM(amount) as revenue
      FROM orders WHERE year = $args.year
      GROUP BY month ORDER BY month
      """
    )
    @task
}

type ReportData @task_response {
  month: Int!
  orders: Int!
  revenue: Float!
}
```

**Generated Operations:**

- `triggerTaskGenerateYearlyReport(year: Int!): TaskTriggerResult!` - Start the task, returns `taskId`
- `taskResultGenerateYearlyReport(taskId: ID!): TaskResultGenerateYearlyReport!` - Poll for results

**Task Result Response:**

- `taskStatus: TaskStatus!` - RUNNING, SUCCEEDED, or FAILED
- `result: [ReportData!]` - Query results (null if still running or failed)
- `startDate: AWSDateTime!` - When the query started
- `finishDate: AWSDateTime` - When the query finished (null if still running)

### `@return` - Computed Values

```graphql
type SearchResult @resolver {
  results: [User!]!
    @sql_query(query: "SELECT * FROM user WHERE name ILIKE '%$args.query%'")
  searchQuery: String! @return(value: "$args.query")
  timestamp: String! @return(value: "new Date().toISOString()")
}
```

## 🔧 Management Commands

### Deploy

```bash
oc-graphql deploy -n my-project -f schema.graphql --region us-east-1
```

### Safe Destroy (Retains Data)

```bash
oc-graphql destroy -n my-project --retain-storage
```

### Complete Destroy (Deletes Everything)

```bash
oc-graphql destroy -n my-project --delete-all
```

### Status Check

```bash
oc-graphql status -n my-project
```

## 🏗️ Framework Architecture

OC-GraphQL provides a complete abstraction layer over AWS services:

### Code Generation

- **Automatic Lambda Functions**: Generates optimized Node.js and Python functions based on your schema
- **Infrastructure as Code**: Uses AWS CDK to define and deploy all resources
- **Type-Safe Resolvers**: Auto-generates AppSync resolvers with proper type mapping

### Built-in Patterns

- **Single-Table DynamoDB**: Optimized key structure for efficient queries
- **Parquet Data Pipeline**: Real-time stream processing with intelligent type detection
- **SQL Query Abstraction**: Direct SQL in GraphQL with automatic parameter sanitization
- **Connection Management**: Optimized AWS SDK usage with connection pooling

### Operational Excellence

- **Auto-scaling**: All components scale automatically based on demand
- **Monitoring**: CloudWatch integration for metrics, logs, and alarms
- **Security**: Built-in IAM policies, SQL injection protection, and encryption
- **Cost Optimization**: Right-sized resources with 90-98% storage cost reduction

## 📋 Requirements

- **AWS Account** with appropriate permissions (IAM, CloudFormation, AppSync, Lambda, DynamoDB, S3, Athena, Glue)
- **Node.js** 18+ for CLI tool
- **AWS CLI** configured with credentials
- **CDK Bootstrap** (automatic on first deployment)

## 🤝 Contributing

Please read [Contributing Guide](CONTRIBUTING.md) for details.

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.
