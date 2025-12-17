# Naming Conventions

OC-GraphQL follows strict naming conventions to ensure consistency, predictability, and easy resource identification across all AWS services and components.

## 🎯 Core Naming Principles

### 1. **Consistency**: All resources follow predictable patterns

### 2. **Hierarchy**: Names reflect component relationships

### 3. **Identification**: Easy to identify project and resource type

### 4. **AWS Compliance**: Follow AWS naming restrictions and best practices

## 📋 Naming Pattern Structure

### Base Pattern

```
{PREFIX}-{PROJECT}-{COMPONENT}-{IDENTIFIER}
```

**Components:**

- **PREFIX**: `OCG` (OC-GraphQL)
- **PROJECT**: User-defined project name (kebab-case)
- **COMPONENT**: Resource type/function category
- **IDENTIFIER**: Specific resource identifier

## 🔧 AWS Resource Naming

### CloudFormation Stack

```
Pattern: OcGraphql-{projectName}
Example: OcGraphql-my-blog-api
```

### Lambda Functions

Lambda function names use different patterns depending on the function type:

**Hash-Based Naming (for CRUD, Mutations, Task Triggers, Task Results):**
Used to avoid AWS's 64-character limit for functions that may have long names.

```
Pattern: OCG-{project}-{hash}
Where hash = first 16 characters of SHA256({project}-{category}-{identifier})

Examples:
- OCG-blog-a1b2c3d4e5f6g7h8 (for blog-create-user)
- OCG-blog-i9j0k1l2m3n4o5p6 (for blog-mutation-likePost)
- OCG-blog-q7r8s9t0u1v2w3x4 (for blog-query-taskResultGetUsersByCity)
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

**Function Categories:**

- CRUD: `{project}-{operation}-{entity}` (e.g., `blog-create-user`) → Hash-based
- Mutations: `{project}-mutation-{mutationName}` (e.g., `blog-mutation-likePost`) → Hash-based
- Task Triggers: `{project}-mutation-triggerTask{QueryName}` (e.g., `blog-mutation-triggerTaskGetUsersByCity`) → Hash-based
- Task Results: `{project}-query-taskResult{QueryName}` (e.g., `blog-query-taskResultGetUsersByCity`) → Hash-based
- Stream Processor: `OCG-{project}-stream-processor` → Descriptive (no hash)
- Cascade Deletion Listener: `OCG-{project}-cascade-deletion-listener` → Descriptive (no hash)
- Deletion Listener: `OCG-{project}-deletion-listener` → Descriptive (no hash)
- Athena Execution Tracker: `OCG-{project}-athena-execution-tracker` → Descriptive (no hash)

### DynamoDB Resources

#### Table Name

```
Pattern: OCG-{projectName}
Example: OCG-my-blog-api
```

#### Key Structure

```
Regular Entities:
PK: "{entityType}#{id}"
SK: "{entityType}#{id}"
Examples:
- PK: "user#123", SK: "user#123"
- PK: "post#456", SK: "post#456"

Join Tables (Relationships):
PK: "relation#{tableName}#{entity1Type}#{entity1Id}"
SK: "relation#{tableName}#{entity2Type}#{entity2Id}"
Examples:
- PK: "relation#user_posts#user#123", SK: "relation#user_posts#post#456"
- PK: "relation#user_followers#user#123", SK: "relation#user_followers#user#789"
```

### S3 Resources

#### Bucket Names

**Note:** S3 bucket names must be lowercase (AWS requirement).

```
Data Lake Bucket:
Pattern: ocg-{projectName}-{accountId}
Example: ocg-my-blog-api-123456789012

Athena Results Bucket:
Pattern: ocg-{projectName}-athena-results-{accountId}
Example: ocg-my-blog-api-athena-results-123456789012
```

#### S3 Object Keys (Parquet Files)

##### Regular Entities

```
Pattern: tables/{entityType}/year={YYYY}/month={MM}/day={DD}/{entityId}.parquet
Examples:
- tables/user/year=2024/month=12/day=15/user-123.parquet
- tables/post/year=2024/month=12/day=15/post-456.parquet
```

##### Join Tables

```
Pattern: tables/{joinTableName}/year={YYYY}/month={MM}/day={DD}/{compositeKey}.parquet
Examples:
- tables/user_posts/year=2024/month=12/day=15/user_123_post_456.parquet
- tables/user_followers/year=2024/month=12/day=15/user_123_user_789.parquet
```

##### Athena Query Results

```
Pattern: athena-results/query-results/{queryId}/
Example: athena-results/query-results/abc123-def456-ghi789/
```

### AWS Glue Resources

#### Database Name

```
Pattern: {projectName}_db
Example: my_blog_api_db
```

#### Table Names

```
Regular Entities:
Pattern: {entityType}
Examples: user, post, comment, article

Join Tables:
Pattern: {joinTableName}
Examples: user_posts, user_followers, post_tags
```

#### Partition Columns

```
Standard Partitions (All Tables):
- year (string)
- month (string)
- day (string)
```

### AppSync Resources

#### GraphQL API Name

```
Pattern: {projectName}-api
Example: my-blog-api-api
```

#### Data Source Names

```
Pattern: {functionName}DataSource
Examples:
- OCG-blog-create-userDataSource
- OCG-blog-query-getPublishedPostsDataSource
- OCG-blog-resolver-postconnectionDataSource
```

#### Resolver Names

```
CRUD Resolvers:
Pattern: {operation}{EntityName}Resolver
Examples:
- createUserResolver
- readPostResolver
- updateCommentResolver

Task Trigger Mutations:
Pattern: triggerTask{QueryName}Resolver
Examples:
- triggerTaskGetUsersByCityResolver
- triggerTaskGenerateReportResolver

Task Result Queries:
Pattern: taskResult{QueryName}Resolver
Examples:
- taskResultGetUsersByCityResolver
- taskResultGenerateReportResolver
```

### IAM Resources

#### Execution Role

```
Pattern: {StackName}-LambdaExecutionRole-{randomSuffix}
Example: OcGraphql-my-blog-api-LambdaExecutionRole-ABC123
```

#### Policy Names

```
Inline Policies:
- DynamoDBPolicy
- AthenaPolicy
- S3Policy
- GluePolicy
```

## 📁 File Naming (Generated Code)

### Lambda Function Files

```
CRUD Functions:
Pattern: ocg-{project}-{operation}-{entity}.js
Examples:
- ocg-blog-create-user.js
- ocg-blog-read-post.js

Query Functions:
Pattern: ocg-{project}-query-{queryName}.js
Examples:
- ocg-blog-query-getPublishedPosts.js

Resolver Functions:
Pattern: ocg-{project}-resolver-{typeName}.js
Examples:
- ocg-blog-resolver-postconnection.js

Stream Processor:
Pattern: ocg-{project}-stream-processor.py
Example: ocg-blog-stream-processor.py
```

### Schema Files

```
Processed Schema:
Pattern: processed-schema.graphql
```

### Configuration Files

```
Package Configuration:
Pattern: package.json
```
