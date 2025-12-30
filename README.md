# OC-GraphQL

**oc-graphql** is a serverless GraphQL analytics framework built on AWS that automatically handles CRUD operations, data partitioning and compression while enabling raw SQL queries through your GraphQL API. The framework simplifies analytics integration by introducing just two custom directives — `@sql_query` and `@task_result` — with all the complex infrastructure managed automatically behind the scenes.

**[Read How It Works](./docs/how-it-works.md)**

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

## Complete Documentation

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
}

type Post {
  id: ID!
  title: String!
  content: String!
  userId: ID!
}

type PostAnalytics @task_response {
  id: ID!
  title: String!
  likes: Int!
}

type Query {
  getTrendingPosts(days: Int = 7): [PostAnalytics!]!
    @sql_query(
      query: """
      SELECT p.id, p.title, COUNT(pl.postId) as likes
      FROM post p
      LEFT JOIN post_likes pl ON p.id = pl.postId
      WHERE p.createdAt >= current_date - interval '$args.days' day
      GROUP BY p.id, p.title
      ORDER BY likes DESC
      LIMIT 10
      """
    )
}

type Mutation {
  likePost(userId: ID!, postId: ID!)
    @sql_query(
      query: "INSERT INTO $join_table(post_likes) (userId:User, postId:Post) VALUES ($args.userId, $args.postId)"
    )

  unlikePost(userId: ID!, postId: ID!)
    @sql_query(
      query: "DELETE pl FROM $join_table(post_likes) pl WHERE pl.userId = $args.userId AND pl.postId = $args.postId;"
    )
}
EOF

# 2. Deploy to AWS
oc-graphql deploy -n my-api -f schema.graphql

# 3. Start querying your API!
# GraphQL endpoint will be displayed after deployment
```

### Deploying From The Source

```bash
git clone https://github.com/acikelli/oc-graphql.git

npm i

npm run build

node dist/cli.js deploy -n demo  -f ./schema.graphql
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
- **S3 Data Lake** with Parquet storage and date partitioning
- **Glue Tables** created automatically during deployment with partition projection for ultra-fast queries
- **IAM Roles** with least-privilege security policies
- **CloudWatch Logs** for comprehensive monitoring and debugging

### Function Types Generated

| **Function Type**   | **Count**                           | **Runtime**  | **Memory** | **Timeout** | **Purpose**               |
| ------------------- | ----------------------------------- | ------------ | ---------- | ----------- | ------------------------- |
| CRUD Operations     | 4 per entity                        | Node.js 18.x | 1024 MB    | 30 seconds  | Basic database operations |
| Task Mutations      | 1 per Query field                   | Node.js 18.x | 1024 MB    | 30 seconds  | Trigger async tasks       |
| Task Result Queries | 1 per Query field                   | Node.js 18.x | 1024 MB    | 30 seconds  | Poll task results         |
| Execution Tracker   | 1 per project (if tasks exist)      | Node.js 18.x | 1024 MB    | 5 minutes   | Track Athena executions   |
| Stream Processor    | 1 per project                       | Python 3.11  | 1024 MB    | 5 minutes   | Real-time data pipeline   |
| Cascade Deletion    | 1 per project                       | Node.js 18.x | 1024 MB    | 15 minutes  | Handle join table cleanup |
| Deletion Listener   | 1 per project (if DELETE mutations) | Node.js 18.x | 1024 MB    | 15 minutes  | Process DELETE operations |

**Function Naming Pattern**:

- CRUD/Mutations/Tasks: `OCG-{project}-{hash}` (hash is first 16 characters of SHA256 hash)
- Project-level functions: `OCG-{project}-{function-name}` (descriptive names, no hash)

All functions are automatically configured with:

- Environment variables for DynamoDB, S3, Athena, and Glue access
- IAM roles with least-privilege permissions
- Connection reuse and retry logic for optimal performance
- Comprehensive error handling and logging

## Custom Directives

### `@sql_query` - Direct SQL Integration

The `@sql_query` directive allows you to execute SQL queries directly within GraphQL resolvers.

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

### Automatic Task Execution for Query Fields

All `Query` fields are automatically executed as asynchronous tasks to handle long-running queries that may exceed AppSync's 30-second timeout.

**Requirements:**

- All `Query` fields are automatically tasks (no `@task` directive needed)
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

### `@task_response` - Task Response Types

Types marked with `@task_response` are used exclusively as return types for Query fields (which are automatically tasks). These types do not generate CRUD operations.

```graphql
type ReportData @task_response {
  month: Int!
  orders: Int!
  revenue: Float!
}
```

### Join Tables with `$join_table()`

For many-to-many relationships, use the `$join_table()` wrapper in INSERT and DELETE operations:

```graphql
type Mutation {
  # INSERT into join table
  addProductToFavorite(userId: ID!, productId: ID!)
    @sql_query(
      query: "INSERT INTO $join_table(user_favorite_products) (userId:User, productId:Product) VALUES ($args.userId, $args.productId)"
    )

  # DELETE from join table (must use $join_table() wrapper)
  removeProductFromFavorite(productId: ID!)
    @sql_query(
      query: "DELETE ufp FROM $join_table(user_favorite_products) ufp WHERE ufp.productId = $args.productId;"
    )
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

## 📋 Requirements

- **AWS Account** with appropriate permissions (IAM, CloudFormation, AppSync, Lambda, DynamoDB, S3, Athena, Glue)
- **Node.js** 18+ for CLI tool
- **AWS CLI** configured with credentials
- **CDK Bootstrap** (automatic on first deployment)

## 🤝 Contributing

OC-GraphQL is open source and welcomes contributions! We're excited to have you join our community.

- **Report Issues**: Found a bug or have a feature request? [Open an issue](https://github.com/acikelli/oc-graphql/issues)

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.
