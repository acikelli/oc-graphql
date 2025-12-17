# Security Features

## 🛡️ Security Architecture Overview

1. **Input Validation & Sanitization** - SQL injection prevention
2. **Access Control** - IAM-based permissions and API authentication

## 🔒 SQL Injection Protection

### Automatic Parameter Sanitization

OC-GraphQL implements robust SQL injection protection through automatic parameter escaping:

```javascript
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  } else if (typeof value === "number") {
    // Validate number to prevent injection via scientific notation
    if (!isFinite(value)) {
      throw new Error("Invalid number value");
    }
    return value.toString();
  } else if (typeof value === "boolean") {
    return value ? "true" : "false";
  } else if (typeof value === "string") {
    // SQL standard escaping: escape single quotes
    let escaped = value.split("'").join("''");
    // Note: We preserve content to maintain search functionality
    // Athena handles this safely when parameters are properly quoted
    return "'" + escaped + "'";
  } else {
    throw new Error("Unsupported data type for SQL parameter");
  }
}
```

### Parameter Replacement Strategy

#### Safe Parameter Substitution

```javascript
// Replace parameter placeholders with SQL-safe escaping
if (event.arguments) {
  Object.entries(event.arguments).forEach(([key, value]) => {
    const argsPattern = "$args." + key;
    const sourcePattern = "$source." + key;
    const sqlSafeValue = escapeSqlValue(value);
    query = query.split(argsPattern).join(sqlSafeValue);
    query = query.split(sourcePattern).join(sqlSafeValue);
  });
}
```

#### Protected Query Examples

##### Before (Vulnerable)

```sql
-- Dangerous: Direct string interpolation
SELECT * FROM user WHERE name = '${userInput}'
-- Could be exploited with: '; DROP TABLE user; --
```

##### After (Secure)

```sql
-- Safe: Automatic escaping
SELECT * FROM user WHERE name = 'O''Brien'  -- Single quote properly escaped
SELECT * FROM user WHERE age = 25           -- Numbers validated
SELECT * FROM user WHERE active = true      -- Booleans handled
```

## 🔐 Access Control & Authentication

### IAM Role-Based Security

#### Least Privilege Principle

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem"
      ],
      "Resource": "arn:aws:dynamodb:region:account:table/specific-project-table"
    }
  ]
}
```

#### Function-Specific Permissions

```typescript
// CRUD functions: Limited DynamoDB access
const crudPolicy = new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem",
  ],
  resources: [table.tableArn],
});

// Query functions: Additional Athena access
const queryPolicy = new iam.PolicyStatement({
  effect: iam.Effect.ALLOW,
  actions: [
    "athena:StartQueryExecution",
    "athena:GetQueryExecution",
    "athena:GetQueryResults",
  ],
  resources: ["*"],
  conditions: {
    StringEquals: {
      "athena:QueryExecutionId": "${aws:RequestedRegion}",
    },
  },
});
```

### Resource-Level Security

#### S3 Bucket Policies

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "LambdaAccessOnly",
      "Effect": "Allow",
      "Principal": {
        "AWS": "arn:aws:iam::account:role/OCG-project-LambdaExecutionRole"
      },
      "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
      "Resource": "arn:aws:s3:::project-bucket/*"
    },
    {
      "Sid": "DenyPublicAccess",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "s3:*",
      "Resource": [
        "arn:aws:s3:::project-bucket",
        "arn:aws:s3:::project-bucket/*"
      ],
      "Condition": {
        "StringNotEquals": {
          "aws:PrincipalServiceName": [
            "lambda.amazonaws.com",
            "athena.amazonaws.com"
          ]
        }
      }
    }
  ]
}
```
