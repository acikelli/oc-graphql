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

#### CRUD Operations

```
Pattern: OCG-{project}-{operation}-{entity}
Examples:
- OCG-blog-create-user
- OCG-blog-read-post
- OCG-blog-update-comment
- OCG-blog-delete-article
```

#### Query Functions

```
Pattern: OCG-{project}-query-{queryName}
Examples:
- OCG-blog-query-getPublishedPosts
- OCG-blog-query-searchUsers
- OCG-blog-query-getUsersByCity
```

#### Mutation Functions

```
Pattern: OCG-{project}-mutation-{mutationName}
Examples:
- OCG-blog-mutation-likePost
- OCG-blog-mutation-followUser
- OCG-blog-mutation-addComment
```

#### Resolver Functions

```
Pattern: OCG-{project}-resolver-{typeName}
Examples:
- OCG-blog-resolver-postconnection
- OCG-blog-resolver-useranalytics
- OCG-blog-resolver-commentpagination
```

#### Field Resolver Functions

```
Pattern: OCG-{project}-field-{typeName}-{fieldName}
Examples:
- OCG-blog-field-user-totalPosts
- OCG-blog-field-post-likeCount
- OCG-blog-field-comment-authorDetails
```

#### Stream Processor

```
Pattern: OCG-{project}-stream-processor
Example: OCG-blog-stream-processor
```

### DynamoDB Resources

#### Table Name

```
Pattern: {projectName}
Example: my-blog-api
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

```
Data Lake Bucket:
Pattern: {projectName}-{accountId}
Example: my-blog-api-123456789012

Athena Results Bucket:
Pattern: {projectName}-athena-results-{accountId}
Example: my-blog-api-athena-results-123456789012
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
aws lambda list-functions --query "Functions[?starts_with(FunctionName, 'OCG-my-blog-')]"
```

#### All S3 Objects for an Entity Type

```bash
aws s3 ls s3://my-blog-api-123456789012/tables/user/ --recursive
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
Functions: OCG-blog-create-user, OCG-blog-read-post
Database: blog_db
Buckets: blog-123456789012
```

### Medium Project (E-commerce)

```
Project: ecommerce-platform
Stack: OcGraphql-ecommerce-platform
Functions: OCG-ecommerce-platform-create-product
Database: ecommerce_platform_db
Buckets: ecommerce-platform-123456789012
```

### Large Project (Enterprise)

```
Project: enterprise-crm-system
Stack: OcGraphql-enterprise-crm-system
Functions: OCG-enterprise-crm-system-resolver-customeranalytics
Database: enterprise_crm_system_db
Buckets: enterprise-crm-system-123456789012
```

---

Following these naming conventions ensures consistent resource management, easy debugging, and seamless team collaboration across all OC-GraphQL projects.
