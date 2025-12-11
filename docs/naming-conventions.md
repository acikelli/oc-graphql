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

**Note:** Lambda function names use a hash-based pattern to avoid AWS's 64-character limit. The hash is generated from the full function identifier and truncated to 16 characters.

```
Pattern: OCG-{project}-{hash}
Where hash = first 16 characters of SHA256({project}-{category}-{identifier})

Examples:
- OCG-blog-a1b2c3d4e5f6g7h8 (for blog-create-user)
- OCG-blog-i9j0k1l2m3n4o5p6 (for blog-mutation-likePost)
- OCG-blog-q7r8s9t0u1v2w3x4 (for blog-query-taskResultGetUsersByCity)
- OCG-blog-y5z6a7b8c9d0e1f2 (for blog-stream-processor)
```

**Function Categories:**

- CRUD: `{project}-{operation}-{entity}` (e.g., `blog-create-user`)
- Mutations: `{project}-mutation-{mutationName}` (e.g., `blog-mutation-likePost`)
- Task Triggers: `{project}-mutation-triggerTask{QueryName}` (e.g., `blog-mutation-triggerTaskGetUsersByCity`)
- Task Results: `{project}-query-taskResult{QueryName}` (e.g., `blog-query-taskResultGetUsersByCity`)
- Stream Processor: `{project}-stream-processor`
- Cascade Deletion Listener: `{project}-cascade-deletion-listener`
- Deletion Listener: `{project}-deletion-listener`
- Athena Execution Tracker: `{project}-athena-execution-tracker`

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

Query Resolvers:
Pattern: {queryName}Resolver
Examples:
- getPublishedPostsResolver
- searchUsersResolver

Field Resolvers:
Pattern: {EntityName}{fieldName}Resolver
Examples:
- UserpostsResolver
- PostlikeCountResolver
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

## 🎨 Naming Style Guidelines

### Case Conventions

#### kebab-case (Preferred)

```
Used for:
- Project names: my-blog-api
- Resource identifiers: user-posts
- Function names: create-user
```

#### snake_case

```
Used for:
- Database names: my_blog_api_db
- Join table names: user_posts
- Glue table names: user_followers
```

#### PascalCase

```
Used for:
- CloudFormation stack names: OcGraphql-MyBlogApi
- GraphQL type names: UserConnection
- Resolver names: createUserResolver
```

#### camelCase

```
Used for:
- GraphQL field names: totalPosts
- JavaScript variable names: entityType
- Configuration properties: projectName
```

### Length Constraints

```
Resource Type           Min Length    Max Length    Pattern
Project Name           3             63            ^[a-zA-Z][a-zA-Z0-9-]*$
Lambda Function        1             64            AWS Lambda limits
S3 Bucket             3             63            DNS-compliant
DynamoDB Table        3             255           AWS DynamoDB limits
Glue Database         1             255           AWS Glue limits
```

### Character Restrictions

#### Allowed Characters

```
Project Names: a-z, A-Z, 0-9, hyphens (-)
Entity Names: a-z, A-Z, 0-9, underscores (_)
S3 Keys: a-z, A-Z, 0-9, hyphens (-), periods (.), underscores (_), forward slashes (/)
```

#### Forbidden Patterns

```
- Cannot start with hyphen or number
- Cannot end with hyphen
- Cannot contain consecutive hyphens
- Cannot use AWS reserved words
- Cannot use special characters (@#$%^&*)
```

## 🔍 Resource Discovery

### Finding Resources by Pattern

#### All Lambda Functions for a Project

```bash
# List all Lambda functions for a project (hash-based names)
aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'OCG-my-blog-')]"
```

#### All S3 Objects for an Entity Type

```bash
aws s3 ls s3://ocg-my-blog-api-123456789012/tables/user/ --recursive
```

#### All Glue Tables for a Project

```bash
aws glue get-tables --database-name my_blog_api_db
```

### Naming Validation

#### Project Name Validation

```typescript
const validNamePattern = /^[a-zA-Z][a-zA-Z0-9-]*$/;
const isValidLength = name.length >= 3 && name.length <= 63;
const hasValidEnding = !name.endsWith("-");
const hasNoConsecutiveHyphens = !name.includes("--");
```

## 📊 Naming Examples by Project Scale

### Small Project (Blog)

```
Project: blog
Stack: OcGraphql-blog
Functions: OCG-blog-a1b2c3d4e5f6g7h8, OCG-blog-i9j0k1l2m3n4o5p6 (hash-based)
Database: blog_db
Table: OCG-blog
Buckets: ocg-blog-123456789012
```

### Medium Project (E-commerce)

```
Project: ecommerce-platform
Stack: OcGraphql-ecommerce-platform
Functions: OCG-ecommerce-platform-{hash} (hash-based)
Database: ecommerce_platform_db
Table: OCG-ecommerce-platform
Buckets: ocg-ecommerce-platform-123456789012
```

### Large Project (Enterprise)

```
Project: enterprise-crm-system
Stack: OcGraphql-enterprise-crm-system
Functions: OCG-enterprise-crm-system-{hash} (hash-based)
Database: enterprise_crm_system_db
Table: OCG-enterprise-crm-system
Buckets: ocg-enterprise-crm-system-123456789012
```

---

Following these naming conventions ensures consistent resource management, easy debugging, and seamless team collaboration across all OC-GraphQL projects.
