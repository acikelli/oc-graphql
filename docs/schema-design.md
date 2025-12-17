# Schema Design Guide

OC-GraphQL extends GraphQL with powerful custom directives that enable automatic CRUD generation, advanced SQL querying, and sophisticated resolver patterns. This guide covers schema design patterns and best practices.

## 🎯 Schema Design Philosophy

## 📋 Custom Directives

OC-GraphQL supports the following custom directives:

- **`@sql_query`**: Execute SQL queries on Query/Mutation fields (required)
- **`@task_response`**: Mark types as task response types (required for Query field return types)

### 1. `@sql_query` - Direct SQL Integration

Execute SQL queries directly within GraphQL resolvers. **Can only be used on Query and Mutation fields**, not on type fields.

```graphql
directive @sql_query(query: String!) on FIELD_DEFINITION
```

**Important:** `@sql_query` directive can only be applied to fields in the `Query` and `Mutation` root types. It cannot be used on fields in regular type definitions.

#### Automatic Return Type Generation

OC-GraphQL automatically infers and assigns return types for mutations based on the SQL operation type. **You don't need to specify return types for INSERT and DELETE mutations** - they are automatically inferred from the SQL query:

- **INSERT operations**: Automatically return `Boolean!` (returns `true` on success)
- **DELETE operations**: Automatically generate `triggerTask` mutations that return `TaskTriggerResult!` with `taskId`

**Example Schema (without return types):**

```graphql
type Mutation {
  # INSERT mutation - return type automatically set to Boolean!
  addProductToFavorite(userId: ID!, productId: ID!)
    @sql_query(
      query: "INSERT INTO $join_table(user_favorite_products) (userId:User, productId:Product) VALUES ($args.userId, $args.productId)"
    )

  # DELETE mutation - automatically generates triggerTask mutation
  removeBrandFromFavorites(brandId: ID!)
    @sql_query(
      query: "DELETE ufp FROM user_favorite_products ufp INNER JOIN products p ON ufp.productId = p.productId WHERE p.brandId = $args.brandId"
    )
}
```

**Generated Schema (with automatic return types):**

```graphql
type Mutation {
  # INSERT mutation with automatic Boolean! return type
  addProductToFavorite(userId: ID!, productId: ID!): Boolean!

  # DELETE mutation replaced with triggerTask mutation
  triggerTaskRemoveBrandFromFavorites(brandId: ID!): TaskTriggerResult!
}

type Query {
  # DELETE mutation also generates a task result query
  taskResultRemoveBrandFromFavorites(taskId: ID!): DeletionTaskResult!
}
```

**Note:** The return types are automatically added during schema processing. You can omit them in your schema definition for INSERT and DELETE mutations - OC-GraphQL will add them automatically based on the SQL operation type.

#### Usage Examples

##### Basic Entity Queries

```graphql
type Query {
  # Simple data retrieval
  getUsersByCity(city: String!): [User!]!
    @sql_query(query: "SELECT * FROM user WHERE city = $args.city")

  # Aggregated analytics
  getUserStats: UserStats!
    @sql_query(query: "SELECT COUNT(*) as total, AVG(age) as avgAge FROM user")
}
```

##### Advanced Analytics Queries

```graphql
type Query {
  # Complex joins with date filtering
  getPopularPosts(days: Int = 7): [PostAnalytics!]!
    @sql_query(
      query: """
      SELECT
        p.id, p.title,
        COUNT(pl.id) as likes,
        COUNT(DISTINCT c.id) as comments
      FROM post p
      LEFT JOIN post_likes pl ON p.id = pl.post_id
      LEFT JOIN comment c ON p.id = c.post_id
      WHERE p.year = '2024'
        AND p.month = '12'
        AND p.created_at >= current_date - interval '$args.days' day
      GROUP BY p.id, p.title
      ORDER BY likes DESC
      LIMIT $args.limit
      """
    )
}
```

### 2. Automatic Task Execution for Query Fields

All `Query` fields are automatically executed as asynchronous tasks to handle long-running queries that may exceed AppSync's 30-second timeout.

```graphql
directive @task_response on OBJECT
```

#### Requirements

- All `Query` fields are automatically tasks (no `@task` directive needed)
- The return type **must** have the `@task_response` directive
- Types with `@task_response` do **not** generate CRUD operations (they only serve as response types)

#### Usage

For any `Query` field with `@sql_query`, the framework automatically generates:

- **Mutation**: `triggerTask<QueryName>` - Starts the task and returns a `taskId` (which is the Athena execution ID)
- **Query**: `taskResult<QueryName>` - Polls task status and retrieves results

#### How It Works

1. **Task Creation**: Calling `triggerTask<QueryName>` creates a task entity in DynamoDB and starts Athena query execution
2. **Task ID**: The Athena execution ID is used as the task ID (one query per task)
3. **Execution Tracking**: EventBridge Lambda automatically updates task status as queries complete
4. **Result Retrieval**: Use `taskResult<QueryName>` to poll for completion and retrieve results

#### Usage Examples

##### Basic Task Query

```graphql
type Query {
  # Long-running analytics query
  generateYearlyReport(year: Int!): [ReportData!]!
    @sql_query(
      query: """
      SELECT
        month,
        COUNT(*) as total_orders,
        SUM(amount) as total_revenue,
        AVG(amount) as avg_order_value
      FROM orders
      WHERE year = $args.year
      GROUP BY month
      ORDER BY month
      """
    )
}

# Response type must have @task_response directive
type ReportData @task_response {
  month: Int!
  totalOrders: Int!
  totalRevenue: Float!
  avgOrderValue: Float!
}
```

**Generated Operations:**

```graphql
# Mutation to trigger the task
type Mutation {
  triggerTaskGenerateYearlyReport(year: Int!): TaskTriggerResult!
}

# Query to check task status and get results
type Query {
  taskResultGenerateYearlyReport(taskId: ID!): TaskResultGenerateYearlyReport!
}

type TaskTriggerResult {
  taskId: ID! # This is the Athena execution ID
}

type TaskResultGenerateYearlyReport {
  taskStatus: TaskStatus!
  result: [ReportData!] # Null if still running or failed
  startDate: AWSDateTime!
  finishDate: AWSDateTime # Null if still running
}

enum TaskStatus {
  RUNNING
  SUCCEEDED
  FAILED
}
```

##### Usage Flow

```graphql
# 1. Trigger the task
mutation {
  triggerTaskGenerateYearlyReport(year: 2024) {
    taskId # This is the Athena execution ID
  }
}

# 2. Poll for results (repeat until taskStatus is SUCCEEDED or FAILED)
query {
  taskResultGenerateYearlyReport(taskId: "abc-123-def-456") {
    taskStatus
    startDate
    finishDate
    result {
      month
      totalOrders
      totalRevenue
      avgOrderValue
    }
  }
}
```

#### Task Entity Structure

Tasks are stored in DynamoDB with the following structure:

```javascript
{
  PK: "task#<executionId>",
  SK: "task#<executionId>",
  id: "<executionId>", // Same as Athena execution ID
  entityType: "task",
  entityId: "<executionId>",
  taskStatus: "RUNNING", // RUNNING, SUCCEEDED, FAILED
  startDate: "2024-01-15T10:00:00Z",
  finishDate: null, // Set when task completes
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T10:00:00Z"
}
```

#### Execution Tracking

The framework uses a hybrid approach for tracking Athena query executions:

1. **EventBridge Integration**: Native Athena Query State Change events automatically update task status
2. **Polling Fallback** (Always Active): The `taskResult` query polls Athena directly if EventBridge hasn't updated the status, ensuring tasks never get stuck

**How it works:**

- When you call `taskResult`, it first checks DynamoDB for task status
- If the task is still `RUNNING`/`QUEUED`, it polls Athena's `GetQueryExecution` API directly
- Task entity is automatically updated with the latest status and finish date
- Results are retrieved directly from Athena when the task succeeds

This ensures reliable task tracking even without EventBridge configuration.

#### Best Practices

1. **Automatic Task Execution**: All `Query` fields are automatically executed as tasks
2. **Response Type Validation**: Always mark response types with `@task_response` directive
3. **Polling Strategy**: Implement exponential backoff when polling `taskResult` queries
4. **Error Handling**: Check `taskStatus` for `FAILED` and handle errors appropriately
5. **Result Nullability**: The `result` field is nullable - check `taskStatus` before accessing results

### 3. DELETE SQL Operations - Asynchronous Deletion Tasks

Since Athena doesn't support DELETE operations directly, DELETE SQL statements are automatically transformed into SELECT queries that return `s3Key` values, then processed asynchronously as deletion tasks.

#### How DELETE Operations Work

When you define a mutation with a DELETE SQL query:

1. **Automatic Transformation**: The DELETE query is transformed to a SELECT query that returns both `s3Key` and `relationId` values
2. **Task Creation**: A task entity is created with `taskType: "deletionTask"`
3. **Async Execution**: The SELECT query is executed via Athena
4. **Queue Processing**: When the query succeeds, the execution ID is published to a deletion queue
5. **Complete Deletion**: A deletion listener Lambda processes the queue, retrieves results from Athena, and performs complete cleanup:
   - Deletes `joinTableData#{relationId}` items from DynamoDB
   - Queries GSI1 to find all `joinRelation` items for each `relationId`
   - Deletes all `joinRelation` items from DynamoDB
   - Deletes S3 Parquet files

#### DELETE Query Format

DELETE queries **must use the `$join_table()` wrapper** for table names, similar to INSERT queries. The wrapper is automatically removed before the query is executed.

DELETE queries must follow this format:

```sql
DELETE [table_alias] FROM $join_table(table_name) [alias] [JOIN clauses] [WHERE clause];
```

**Examples:**

```graphql
type Mutation {
  # Delete join table entries based on related entity
  # Return type automatically inferred - generates triggerTask mutation
  removeBrandFromFavorites(brandId: ID!)
    @sql_query(
      query: "DELETE ufp FROM $join_table(user_favorite_products) ufp INNER JOIN products p ON ufp.productId = p.productId WHERE p.brandId = $args.brandId;"
    )

  # Delete entries from a specific table
  # Return type automatically inferred - generates triggerTask mutation
  removeProductFromFavorite(productId: ID!)
    @sql_query(
      query: "DELETE ufp FROM $join_table(user_favorite_products) ufp WHERE ufp.productId = $args.productId;"
    )
}
```

#### Automatic Query Transformation

The framework automatically transforms DELETE queries:

1. **Removes `$join_table()` wrapper**: The `$join_table(table_name)` is replaced with `table_name` before execution
2. **Transforms to SELECT**: The DELETE query is transformed to a SELECT query that returns both `s3Key` and `relationId`

**Original DELETE Query:**

```sql
DELETE ufp FROM $join_table(user_favorite_products) ufp
INNER JOIN products p ON ufp.productId = p.productId
WHERE p.brandId = $args.brandId;
```

**After Removing `$join_table()` Wrapper:**

```sql
DELETE ufp FROM user_favorite_products ufp
INNER JOIN products p ON ufp.productId = p.productId
WHERE p.brandId = $args.brandId;
```

**Transformed SELECT Query:**

```sql
SELECT ufp.s3Key, ufp.relationId FROM user_favorite_products ufp
INNER JOIN products p ON ufp.productId = p.productId
WHERE p.brandId = $args.brandId;
```

The table alias (e.g., `ufp`) is automatically detected and used to select both the `s3Key` and `relationId` columns.

#### Generated GraphQL Operations

For each DELETE mutation, the framework automatically generates:

1. **Trigger Mutation**: `triggerTask<MutationName>`

   - Takes the same arguments as the original mutation
   - Returns `{ taskId: ID! }`
   - Creates a task entity with `taskType: "deletionTask"`

2. **Result Query**: `taskResult<MutationName>`
   - Takes `taskId: ID!` as argument
   - Returns `DeletionTaskResult` with:
     - `taskStatus: TaskStatus!` (RUNNING, SUCCEEDED, FAILED)
     - `startDate: AWSDateTime!`
     - `finishDate: AWSDateTime`

**Example:**

```graphql
# Original mutation
type Mutation {
  removeBrandFromFavorites(brandId: ID!): Boolean
    @sql_query(
      query: "DELETE ufp FROM $join_table(user_favorite_products) ufp INNER JOIN products p ON ufp.productId = p.productId WHERE p.brandId = $args.brandId;"
    )
}

# Automatically generated operations
type Mutation {
  triggerTaskRemoveBrandFromFavorites(brandId: ID!): TaskTriggerResult!
}

type Query {
  taskResultRemoveBrandFromFavorites(taskId: ID!): DeletionTaskResult!
}

type DeletionTaskResult {
  taskStatus: TaskStatus!
  startDate: AWSDateTime!
  finishDate: AWSDateTime
}
```

#### Usage Flow

```graphql
# 1. Trigger the deletion task
mutation {
  triggerTaskRemoveBrandFromFavorites(brandId: "brand-123") {
    taskId
  }
}

# 2. Poll for completion (repeat until taskStatus is SUCCEEDED or FAILED)
query {
  taskResultRemoveBrandFromFavorites(taskId: "abc-123-def-456") {
    taskStatus
    startDate
    finishDate
  }
}
```

#### Complete Deletion Process

When a DELETE task completes successfully, the deletion listener performs complete cleanup:

1. **Retrieves Results**: Gets both `s3Key` and `relationId` from Athena query results
2. **Deletes Temporary Data**: Removes `joinTableData#{relationId}` items from DynamoDB
3. **Finds Related Items**: Queries GSI1 (`GSI1-PK: joinRelation#{relationId}`) to find all `joinRelation` items
4. **Deletes Relations**: Removes all `joinRelation` items from DynamoDB
5. **Deletes Files**: Removes S3 Parquet files

This ensures complete cleanup of both DynamoDB metadata and S3 data files when DELETE operations are executed.

#### Deletion Task Entity Structure

Deletion tasks are stored in DynamoDB with:

```javascript
{
  PK: "task#<executionId>",
  SK: "task#<executionId>",
  id: "<executionId>",
  entityType: "task",
  taskId: "<executionId>",
  taskType: "deletionTask", // Identifies this as a deletion task
  mutationName: "removeBrandFromFavorites",
  taskStatus: "RUNNING", // RUNNING, SUCCEEDED, FAILED
  startDate: "2024-01-15T10:00:00Z",
  finishDate: null,
  createdAt: "2024-01-15T10:00:00Z",
  updatedAt: "2024-01-15T10:00:00Z"
}
```

#### Deletion Processing Flow

1. **Task Creation**: `triggerTask` mutation creates task entity and starts Athena query
2. **Query Execution**: Athena executes the transformed SELECT query
3. **EventBridge Tracking**: Execution tracker monitors query status via EventBridge
4. **Queue Publishing**: When query succeeds, execution ID is published to deletion queue
5. **S3 Deletion**: Deletion listener Lambda:
   - Retrieves query results from Athena
   - Extracts `s3Key` values from results
   - Bulk deletes S3 Parquet files (up to 1000 per request)
   - Logs completion

#### Important Notes

- **`$join_table()` Required**: DELETE queries **must** wrap table names with `$join_table()` wrapper (e.g., `DELETE alias FROM $join_table(table_name) alias ...`)
- **Table Alias Required**: DELETE queries must use table aliases (e.g., `DELETE ufp FROM $join_table(...) ufp ...`)
- **Wrapper Removal**: The `$join_table()` wrapper is automatically removed before query execution (similar to INSERT queries)
- **s3Key Column**: The target table must have an `s3Key` column (automatically added for join tables)
- **Asynchronous**: Deletion is asynchronous - use `taskResult` query to track progress
- **Complete Cleanup**: DELETE operations remove both S3 Parquet files and DynamoDB items (`joinTableData` and `joinRelation` items)
- **Error Handling**: Check `taskStatus` for `FAILED` and handle errors appropriately

#### Best Practices

1. **Use for Bulk Deletions**: DELETE operations are best for bulk deletions based on complex conditions
2. **Join Table Deletions**: Perfect for removing join table entries based on related entity properties
3. **Polling Strategy**: Implement exponential backoff when polling `taskResult` queries
4. **Error Handling**: Always check `taskStatus` before assuming deletion completed
5. **Cascade Deletion**: For entity deletions with related data, use cascade deletion instead

```graphql
# Good: Query field automatically executed as task with @task_response type
type Query {
  analyzeCustomerBehavior(
    startDate: AWSDateTime!
    endDate: AWSDateTime!
  ): [AnalysisResult!]!
    @sql_query(query: "SELECT ... complex multi-table join ...")
}

type AnalysisResult @task_response {
  customerId: ID!
  totalOrders: Int!
  averageOrderValue: Float!
}

# Note: All Query fields are automatically tasks, no directive needed
type Query {
  getUser(id: ID!): User
    @sql_query(query: "SELECT * FROM user WHERE id = $args.id")
  # Automatically executed as task, but response type must have @task_response
}
```

## 🏗️ Schema Structure Patterns

### Entity Types (Auto-CRUD)

Regular GraphQL types that automatically generate CRUD operations.

```graphql
type User {
  id: ID!
  email: String!
  name: String!
  age: Int
  city: String
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!
}
```

**Note:** `@sql_query` can only be used on Query and Mutation fields, not on type fields. For analytics queries, define them as Query fields instead.

## 🔗 Join Tables (Many-to-Many Relationships)

Join tables handle complex relationships through SQL INSERT operations and automatic table generation. They support **cascade deletion** - when an entity is deleted, all related join table entries and their S3 files are automatically cleaned up.

### Entity Type Annotations

When defining join table columns, you must specify the entity type for each column using the `columnName:EntityType` syntax. This enables cascade deletion:

```graphql
# Syntax: (columnName:EntityType, columnName:EntityType)
INSERT INTO $join_table(table_name) (userId:User, productId:Product) VALUES ($args.userId, $args.productId)
```

**How it works:**

- The framework extracts entity types (`User`, `Product`, etc.) from the column definitions
- A **deterministic `relationId`** is generated from the table name and entity mappings (sorted alphabetically by entity type and value, then hashed using SHA-256)
  - This ensures that duplicate inserts with the same values return the existing relation instead of creating a new one
  - The table name is included in the hash to prevent collisions across different join tables with the same entity mappings
  - Format: `tableName|entityType1:value1|entityType2:value2|...` (sorted) → SHA-256 hash (first 32 chars)
- Before creating a new relation, the system checks if `joinTableData#<relationId>` already exists
  - If it exists, returns the existing data (prevents duplicates)
  - If it doesn't exist, creates a new relation
- For each entity type, a `joinRelation` item is saved to DynamoDB with:
  - `PK: joinRelation#<entityType>#<entityId>` (lowercase entity type)
  - `SK: joinRelation#<relationId>`
  - `GSI1-PK: joinRelation#<relationId>`
  - `GSI1-SK: joinRelation#<entityType>#<entityId>`
  - `s3Key`: The S3 key of the Parquet file (using `relationId` as filename)
  - `relationId`, `joinTableName`, `relatedEntityType`, `relatedEntityId`, etc.
- The Parquet file is named using the `relationId` (e.g., `tables/user_favorite_products/year=2025/month=12/day=05/<relationId>.parquet`)
- A temporary `joinTableData#<relationId>` item is created and processed by the stream processor
- The stream processor writes the Parquet file to S3 and **automatically deletes** the temporary `joinTableData` item after processing
- When an entity is deleted, the stream processor sends a message to SQS
- A queue listener Lambda:
  1. Queries all `joinRelation` items with `PK: joinRelation#<entityType>#<entityId>` and `SK` starting with `joinRelation#`
  2. For each found `relationId`, queries GSI1 to find all related entities
  3. Bulk deletes all related S3 Parquet files
  4. Deletes all `joinRelation` items from DynamoDB

**Example Flow:**

```graphql
type Mutation {
  # Return type automatically set to Boolean! for INSERT operations
  addProductToFavorite(userId: ID!, productId: ID!)
    @sql_query(
      query: "INSERT INTO $join_table(user_favorite_products) (userId:User, productId:Product) VALUES ($args.userId, $args.productId)"
    )
}
```

**Note:** The return type `Boolean!` is automatically inferred - you don't need to specify it in your schema.

When this mutation is called:

1. Entity mappings are extracted: `[{entityType: "User", value: userId}, {entityType: "Product", value: productId}]`
2. Mappings are sorted alphabetically: `[{entityType: "Product", value: productId}, {entityType: "User", value: userId}]`
3. A deterministic `relationId` is generated: `SHA-256("user_favorite_products|product:<productId>|user:<userId>")` → first 32 chars (e.g., `"a1b2c3d4e5f6..."`)
   - The table name is included to prevent collisions if the same entity mappings are used in different join tables
4. The system checks if `joinTableData#<relationId>` already exists:
   - **If exists**: Returns the existing relation data (prevents duplicate inserts)
   - **If not exists**: Proceeds with creating a new relation
5. Two `joinRelation` items are created:
   - `PK: joinRelation#user#<userId>`, `SK: joinRelation#<relationId>`, `GSI1-PK: joinRelation#<relationId>`, `GSI1-SK: joinRelation#user#<userId>`, `s3Key: tables/user_favorite_products/year=2025/month=12/day=05/<relationId>.parquet`
   - `PK: joinRelation#product#<productId>`, `SK: joinRelation#<relationId>`, `GSI1-PK: joinRelation#<relationId>`, `GSI1-SK: joinRelation#product#<productId>`, `s3Key: tables/user_favorite_products/year=2025/month=12/day=05/<relationId>.parquet`
6. A temporary `joinTableData#<relationId>` item is created and processed by the stream processor
7. The stream processor writes a Parquet file named `<relationId>.parquet` to S3
8. The stream processor **automatically deletes** the temporary `joinTableData` item after processing

When `User` with `id="123"` is deleted:

1. Stream processor deletes the User's S3 file
2. Stream processor sends SQS message: `{entityType: "user", entityId: "123"}`
3. Cascade deletion listener:
   - Queries: `PK = joinRelation#user#123 AND SK begins_with joinRelation#`
   - Finds all `relationId`s for this user
   - For each `relationId`, queries GSI1 to find all related entities (e.g., products)
   - Bulk deletes all related S3 Parquet files
   - Deletes all `joinRelation` items from DynamoDB

**Supporting Multiple Entity Types:**

You can now insert into join tables with more than two entity types:

```graphql
type Mutation {
  createProjectAssignment(
    userId: ID!
    projectId: ID!
    roleId: ID!
  ): ProjectAssignment
    @sql_query(
      query: "INSERT INTO $join_table(project_assignments) (userId:User, projectId:Project, roleId:Role) VALUES ($args.userId, $args.projectId, $args.roleId)"
    )
}
```

This creates three `joinRelation` items (one for each entity type) all sharing the same `relationId`, enabling efficient cascade deletion across all related entities.

### Join Table Patterns

#### User Favorites System

```graphql
type Mutation {
  # Creates entries in join table "user_favorites"
  # Entity type annotations enable cascade deletion
  addToFavorites(userId: ID!, productId: ID!): UserFavorite!
    @sql_query(
      query: "INSERT INTO $join_table(user_favorites) (userId:User, productId:Product) VALUES ($args.userId, $args.productId)"
    )

  removeFromFavorites(userId: ID!, productId: ID!): Boolean!
    @sql_query(
      query: "DELETE uf FROM $join_table(user_favorites) uf WHERE uf.userId = $args.userId AND uf.productId = $args.productId;"
    )
}

type Query {
  # Query join table data
  getUserFavorites(userId: ID!): [Product!]!
    @sql_query(
      query: """
      SELECT p.* FROM product p
      JOIN user_favorites uf ON p.id = uf.product_id
      WHERE uf.user_id = $args.userId
      ORDER BY uf.created_at DESC
      """
    )
}
```

#### Social Following System

```graphql
type Mutation {
  followUser(followerId: ID!, followingId: ID!): UserFollow!
    @sql_query(
      query: "INSERT INTO $join_table(user_follows) (followerId:User, followingId:User) VALUES ($args.followerId, $args.followingId)"
    )

  unfollowUser(followerId: ID!, followingId: ID!): Boolean!
    @sql_query(
      query: "DELETE uf FROM $join_table(user_follows) uf WHERE uf.followerId = $args.followerId AND uf.followingId = $args.followingId;"
    )
}
```
