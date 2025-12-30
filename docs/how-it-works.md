**oc-graphql** is a serverless GraphQL analytics framework built on AWS that automatically handles CRUD operations, data partitioning and compression while enabling raw SQL queries through your GraphQL API. The framework simplifies analytics integration by introducing just two custom directives — `@sql_query` and `@task_result` — with all the complex infrastructure managed automatically behind the scenes.

Let's start by deploying the schema below using our framework first by running the command below:

```bash
oc-graphql deploy -n demo -f schema.graphql
```

```graphql
scalar AWSDateTime

type Query {
  getUsersByCity(city: String!): [UserTaskResponse]
    @sql_query(
      query: "SELECT u.*, COUNT(*) OVER() AS total FROM user u JOIN address a ON u.id = a.userId WHERE a.city = $args.city"
    )
  getUserFavoriteProducts(userId: String!): [ProductTaskResponse]
    @sql_query(
      query: "SELECT * FROM product p JOIN user_favorite_products ufp ON p.id = ufp.productId WHERE ufp.userId = $args.userId"
    )
}

type Mutation {
  addProductToFavorite(userId: ID!, productId: ID!)
    @sql_query(
      query: "INSERT INTO $join_table(user_favorite_products) (userId:User, productId:Product) VALUES ($args.userId, $args.productId)"
    )
  removeProductFromFavorite(productId: ID!)
    @sql_query(
      query: "DELETE ufp FROM $join_table(user_favorite_products) ufp WHERE ufp.productId = $args.productId;"
    )
  removeBrandFromFavorites(brandId: ID!)
    @sql_query(
      query: "DELETE ufp FROM $join_table(user_favorite_products) ufp INNER JOIN product p ON ufp.productId = p.id WHERE p.brandId = $args.brandId;"
    )
}

type UserTaskResponse @task_response {
  id: ID!
  name: String!
  email: String!
  password: String!
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!
  total: Int!
}

type Address {
  id: ID!
  userId: ID!
  city: String!
  state: String!
  zip: String!
  country: String!
  addressLine1: String!
  addressLine2: String!
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!
}

type ProductTaskResponse @task_response {
  id: ID!
  name: String!
  brandId: ID!
  price: Float!
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!
}

type Brand {
  id: ID!
  name: String!
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!
}

type Product {
  id: ID!
  name: String!
  brandId: ID!
  price: Float!
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!
}

type User {
  id: ID!
  name: String!
  email: String!
  password: String!
  createdAt: AWSDateTime!
  updatedAt: AWSDateTime!
}
```

After deploying our schema, a new API named `demo-api` is created on AWS AppSync.

![Alt text](./docs/images/1_AU5xAxp0kT1gv7Q3OHKNlg.webp)

For each object type defined in the schema, create/delete/update mutations and read queries created automatically. For each operation, a Lambda data source gets created and connected to the corresponding Query and Mutation APIs. Lets start investigating `createUser` mutation first.

![Alt text](./docs/images/1_Sjsxx4nayDJT4K6oVd7oSg.webp)

We called the `createUser` mutation with the `name` argument contains [contains 120KB of text](https://gist.github.com/acikelli/8dff53e71456ad80f1917f96dcdadf9c).

Now lets check S3 bucket that's been created per project that stores all of the data.

![Alt text](./docs/images/1_xayWzjeLfhvjHGPBgrTWXg.webp)

A parquet file with the name of the unique `userId` is saved to the S3 bucket. Notice that even though our input data's `name` argument is 120KB in size, the parquet file is only 9KB in size(considering parquet metadata contains some 3KB alone). The compression is automatically done by the framework.

![Alt text](./docs/images/1_pL9T0yMeViPJv_Px6iqUrQ.webp)

Under the hood, `createUser` mutation is connected to a Lambda data source that has been created for the mutation. The connected data source Lambda creates an unique ID for the user and saves the user item to the DynamoDB. Then returns response to the mutation.

```javascript
// General format for all entity types
{
  PK: `{entityType}#{id}`,
  SK: `{entityType}#{id}`,
  entityType: '{entityType}',
  ...other attributes
}

// The user item saved
{
  PK: `user#bd9d0faf-6e8a-4309-83e6-279f37ea0ded`,
  SK: `user#bd9d0faf-6e8a-4309-83e6-279f37ea0ded`,
  id,
  ...input,
  entityType: 'user',
  createdAt: now,
  updatedAt: now
}
```

After the item is saved, another Lambda listens the streams from the DynamoDB table to perform create/update/delete operations on the parquet file asynchronously. Read more about generated Lambdas.

Lets check the created database on Glue.

![Alt text](./docs/images/1_p0ZoVVq39rTyH3r5MAE5pA.webp)

A Glue database is created per project with the name `<project_name>_db`. The framework automatically detects each object type defined in the provided GraphQL schema and creates the corresponding tables and table schemas. Since the framework follows a structural pattern such as `s3://ocg-<project name>-<AWS-account-id>/tables/<entityType>/`, the stream listener Lambda uses the `entityType` attribute to store the generated Parquet file in the correct table location.

Notice that the Parquet file for the created user is written to `tables/user/year=2025/month=12/day=10/bd9d0faf-6e8a-4309-83e6-279f37ea0ded.parquet` for optimized partitioning. The framework references the `createdAt` attribute of the entity to keep it in the same date partition in the bucket after update operations, and it automatically configures Glue tables with `year`, `month`, and `day` columns using partition projection.

Let's run some queries in Athena to verify that everything works correctly.

![Alt text](./docs/images/1_BlkzzEmdNRVTJS6gV2crgQ.webp)

![Alt text](./docs/images/1_wyJ-xMWnAHglqzIV3nAaig.webp)

The first query selects only the `name` field, and the scanned data size is 5.70 KB. The original size of the `name` field provided to the `createUser` mutation was 120 KB, so the compression rate is approximately 95%. The second query returns the `email` field, and the total data scanned is 0.04 KB. The size difference between the two queries demonstrates that columnar pruning also works as expected.

Unlike delete operations, update and read operations are straightforward. Update operations run against the entities stored in DynamoDB, and the stream listener Lambda performs the corresponding updates on the Parquet files. Single-item read operations (e.g., the `readUser` query) return responses directly from DynamoDB.

**oc-graphql** allows running SQL `SELECT`, `INSERT`, and `DELETE` statements using the `@sql_query` directive. Since the provided SQL queries run on Athena—which returns data from Glue tables that use Parquet files as their data source—it is not possible to execute direct `INSERT` or `DELETE` statements. Instead, create and remove operations must be performed on files in S3. The framework handles these processes automatically.

Let's investigate the `INSERT` statement first. In the deployed schema, `Mutation.addProductToFavorite` runs the following query.

```sql
INSERT INTO
  $join_table(user_favorite_products) (userId:User, productId:Product)
VALUES
  ($args.userId, $args.productId)
```

The framework uses a special syntax for `INSERT` statements. The table name must be wrapped with `$join_table`. This requirement is enforced because direct insertions into object types (such as `User`, `Brand`, etc.) must not be performed via raw SQL; instead, their corresponding auto-generated create mutations (e.g., `createUser`) should be used.

Additionally, column types must be provided and separated by a colon (e.g., `userId:User`, `productId:Product`) to ensure that the underlying composite unique constraint and automatic deletion mechanisms function correctly.

When we run the query above, three items are inserted into DynamoDB:

```javascript
// 1. item represents the actual item on the join table
{
  PK: `joinTableData#{relationId}`,        // → joinTableData#58c306f84e4d86c6f7b081d223a5fbf2
  SK: `joinTableData#{relationId}`,
  entityType: tableName,                   // → user_favorite_products
  relationId: {relationId},                // → 58c306f84e4d86c6f7b081d223a5fbf2
  s3Key: s3Key,
  ...other attributes
}

// 2. item for user entity
{
  PK: `joinRelation#{entityType}#{entityId}`,           // → joinRelation#user#123
  SK: `joinRelation#{relationId}`,                      // → joinRelation#58c306f84e4d86c6f7b081d223a5fbf2
  'GSI1-PK': `joinRelation#{relationId}`,               // → joinRelation#58c306f84e4d86c6f7b081d223a5fbf2
  'GSI1-SK': `joinRelation#{entityType}#{entityId}`,    // → joinRelation#user#123
  entityType: 'joinRelation',
  relationId: {relationId},                             // → 58c306f84e4d86c6f7b081d223a5fbf2
  ...other attributes
}

// 3. item for product entity
{
  PK: `joinRelation#{entityType}#{entityId}`,           // → joinRelation#product#456
  SK: `joinRelation#{relationId}`,                      // → joinRelation#58c306f84e4d86c6f7b081d223a5fbf2
  'GSI1-PK': `joinRelation#{relationId}`,               // → joinRelation#58c306f84e4d86c6f7b081d223a5fbf2
  'GSI1-SK': `joinRelation#{entityType}#{entityId}`,    // → joinRelation#product#456
  entityType: 'joinRelation',
  relationId: {relationId},                             // → 58c306f84e4d86c6f7b081d223a5fbf2
  ...other attributes
}
```

The first item created holds metadata about the actual item created in the table and is automatically detected by the stream processor Lambda, which then creates a Parquet file in S3 at the correct table location. Since Glue tables use Parquet files as their data source, triggering the same insert statement with the same arguments could cause data duplication in the join tables. To prevent this, the relation ID is generated in the format shown below.

```
`tableName|entityType1:value1|entityType2:value2|...`
(sorted) → SHA-256 hash (first 32 chars)
```

The system automatically constructs a string that starts with the table name, followed by alphabetically sorted column types (e.g., `"user_favorite_products|product:456|user:123"`). It then hashes this string and takes the first 32 characters to obtain a unique relation ID. If the same mutation runs with the same arguments, the system automatically detects the existence of the same `joinTableData#{relationId}` item on the DynamoDB and prevents data duplication. The mutation returns a success response regardless.

Items 2 and 3 are inserted into DynamoDB to keep track of all entities related to the relation. These items are required to support cascade deletion.

![Alt text](./docs/images/1_4uCVDJP6ysqzAtvRyP6Gzg.webp)

For example, when the `deleteUser` mutation is called, the connected Lambda data source deletes the corresponding entity from the database. The stream listener Lambda then detects the `REMOVE` operation performed on the database and pushes a message containing `entityType` and `entityId` information to a cascade-deletion queue (SQS) created per project.

The consumer Lambda for this queue queries the database by constructing the partition key (PK) as follows: `PK: joinRelation#{entityType}#{entityId}`.

This partition returns all the relations that the entity (the user) has across all join tables, and the Lambda removes all related items from the database along with the associated Parquet files. Then, a second query is run on the GSI (`GSI1-PK: joinRelation#{relationId}`) to find all other entities related to the relation and remove them from DynamoDB as well.

The framework also supports running SQL `DELETE` statements. Lets investigate the SQL query for `Mutation.removeBrandFromFavorites` in the deployed schema.

```sql
DELETE ufp
FROM user_favorite_products ufp
INNER JOIN product p ON ufp.productId = p.id
WHERE p.brandId = $args.brandId;
```

Since the delete operations performed via removing the parquet files, this query will fail. The framework solves this problem by automatically transforming the delete query into a select query.

```sql
DELETE ufp
FROM user_favorite_products ufp
INNER JOIN product p ON ufp.productId = p.id
WHERE p.brandId = $args.brandId;

       ↓
       ↓
       ↓

SELECT ufp.s3Key, ufp.relationId
FROM user_favorite_products ufp
INNER JOIN product p ON ufp.productId = p.id
WHERE p.brandId = $args.brandId;
```

![Alt text](./docs/images/1_4nYy3uKRpKR21wO9Y501aw.webp)

Notice that the actual API created in AppSync does not include a mutation named `removeBrandFromFavorites`. AppSync has a 30-second timeout limit, while queries executed on Athena may take significantly longer.

To address this, the framework automatically converts mutations and queries annotated with the `@sql_query` directive into asynchronous tasks. It then generates:

1. **one mutation** (named `triggerTask{OriginalMutationOrQueryName}`) that returns the created task ID, and
2. **one query** (named `taskResult{OriginalMutationOrQueryName}`) that allows tracking the task result asynchronously.

![Alt text](./docs/images/1_xayWzjeLfhvjHGPBgrTWXa.webp)

Once the `triggerTaskRemoveBrandFromFavorites` mutation is called, its connected data source lambda runs the transformed query on Athena and saves a task entity to the database as below.

```javascript
{
  PK: "task#<executionId>",
  SK: "task#<executionId>",
  entityType: "task",
  taskId: "<executionId>",
  taskType: "deletionTask",
  taskStatus: "RUNNING",     // RUNNING, SUCCEEDED, FAILED
  startDate: {start date},
  finishDate: null,
  ...other attributes
}
```

It then returns the Athena query execution ID as the `taskId`. Executions in Athena are tracked by an EventBridge rule that triggers the execution-tracker Lambda. This Lambda updates the status and completion time of the corresponding task.

If the task succeeds and the `taskType` is `deletionTask`, it pushes a message to the deletion queue containing the Athena query execution ID. A consumer Lambda processes the queue and reads the query result using the execution ID. Note that the transformed query returns only `s3Key` and `relationId`.

The consumer Lambda removes all Parquet files by reading the `s3Key` values and deletes all relation entities in DynamoDB by querying `GSI1-PK: joinRelation#{relationId}`. This partition returns all unique entities related to the relation, and all `joinRelation` and `joinTableData` entities are automatically removed from the database to achieve cascade deletion.

The framework allows SQL `SELECT` statements to be executed by creating a task-triggering mutation and a corresponding query to fetch the result of the created task. Let's take `Query.getUserFavoriteProducts` as an example. The framework automatically creates `Mutation.triggerTaskGetUserFavoriteProducts` and `Query.taskResultGetUserFavoriteProducts`.

The response type of `Query.getUserFavoriteProducts`, `ProductTaskResponse`, is marked with the `@task_response` directive. This directive is required and enforced by the framework to prevent the creation of CRUD APIs for this type, since it is used only to describe the response of the `getUserFavoriteProducts` query and not as a persistent object type.

Lets trigger a task and query its result.

![Alt text](./docs/images/1_OSBjGEaIHOlhf2LOOY05sg.gif)

We first called the `triggerTaskGetUserFavoriteProducts` mutation, which returned a task ID. We then called the `taskResultGetUserFavoriteProducts` query using the obtained task ID. The first call to this query returned `status: RUNNING` and `result: null`.

The status of the task entity in the database is updated by the execution-tracker Lambda, which is triggered by Athena Query State Change events. On the second API call, the task has succeeded and the `result` field returns the query output. The `result` field automatically derives its type from the original query defined in the schema—in this case, `[ProductTaskResponse!]`.
