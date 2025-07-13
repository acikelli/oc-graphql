# Security Features

OC-GraphQL implements comprehensive security measures to protect against common vulnerabilities and ensure enterprise-grade data protection. This guide covers all security features and best practices.

## 🛡️ Security Architecture Overview

### Multi-Layer Security Approach

1. **Input Validation & Sanitization** - SQL injection prevention
2. **Access Control** - IAM-based permissions and API authentication
3. **Data Encryption** - At-rest and in-transit encryption
4. **Network Security** - VPC and security groups
5. **Monitoring & Auditing** - Comprehensive logging and alerting

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

### Input Validation

#### Type Validation

```javascript
// Automatic type checking prevents injection attempts
function validateInput(value, expectedType) {
  switch (expectedType) {
    case "String":
      if (typeof value !== "string") {
        throw new Error("Expected string value");
      }
      // Additional string validation
      if (value.length > 10000) {
        throw new Error("String too long");
      }
      break;
    case "Int":
      if (!Number.isInteger(value)) {
        throw new Error("Expected integer value");
      }
      if (value < Number.MIN_SAFE_INTEGER || value > Number.MAX_SAFE_INTEGER) {
        throw new Error("Integer out of safe range");
      }
      break;
    case "Boolean":
      if (typeof value !== "boolean") {
        throw new Error("Expected boolean value");
      }
      break;
  }
}
```

#### GraphQL Schema Validation

```graphql
# Built-in type safety prevents many injection attempts
type Query {
  searchUsers(
    name: String! # Required string (not null)
    age: Int # Optional integer (validated)
    limit: Int = 10 # Default value with bounds checking
  ): [User!]!
}
```

## 🔐 Access Control & Authentication

### AppSync API Security

#### API Key Authentication

```typescript
// Default authentication method
authorizationConfig: {
  defaultAuthorization: {
    authorizationType: appsync.AuthorizationType.API_KEY,
    apiKeyConfig: {
      expires: Expiration.after(Duration.days(365)),
    },
  },
}
```

#### Advanced Authentication Options

```typescript
// Multiple authentication providers (configurable)
authorizationConfig: {
  defaultAuthorization: {
    authorizationType: appsync.AuthorizationType.USER_POOL,
  },
  additionalAuthorizationModes: [
    {
      authorizationType: appsync.AuthorizationType.IAM,
    },
    {
      authorizationType: appsync.AuthorizationType.LAMBDA,
      lambdaAuthorizerConfig: {
        handler: authorizerFunction,
      },
    },
  ],
}
```

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

#### DynamoDB Table Policies

```typescript
// Enable point-in-time recovery
table.pointInTimeRecovery = true;

// Enable deletion protection in production
table.deletionProtection = true;

// Encryption at rest
table.encryption = dynamodb.TableEncryption.AWS_MANAGED;
```

## 🔑 Data Encryption

### Encryption at Rest

#### S3 Encryption

```typescript
// Server-side encryption for data lake
const dataBucket = new s3.Bucket(this, "DataBucket", {
  encryption: s3.BucketEncryption.S3_MANAGED,
  enforceSSL: true,
  versioned: true,
  publicReadAccess: false,
  publicWriteAccess: false,
});
```

#### DynamoDB Encryption

```typescript
// AWS managed encryption keys
const table = new dynamodb.Table(this, "DataTable", {
  encryption: dynamodb.TableEncryption.AWS_MANAGED,
  pointInTimeRecovery: true,
  deletionProtection: true,
});
```

#### Lambda Environment Variables

```typescript
// Encrypted environment variables
environment: {
  DATABASE_NAME: glueDatabase.ref,
  // Sensitive values stored in Systems Manager Parameter Store
  DB_PASSWORD: ssm.StringParameter.valueForStringParameter(
    this, '/ocg/database/password'
  ),
}
```

### Encryption in Transit

#### HTTPS/TLS Requirements

```typescript
// AppSync enforces HTTPS
const api = new appsync.GraphqlApi(this, 'GraphQLApi', {
  name: `${projectName}-api`,
  // Automatic HTTPS endpoint
  // WSS for subscriptions
});

// S3 bucket policy enforces SSL
{
  "Sid": "DenyInsecureConnections",
  "Effect": "Deny",
  "Principal": "*",
  "Action": "s3:*",
  "Resource": [
    "arn:aws:s3:::bucket-name",
    "arn:aws:s3:::bucket-name/*"
  ],
  "Condition": {
    "Bool": {
      "aws:SecureTransport": "false"
    }
  }
}
```

#### API Gateway Security Headers

```javascript
// CORS configuration
const corsConfig = {
  allowOrigins: ["https://yourapp.com"],
  allowMethods: ["POST", "OPTIONS"],
  allowHeaders: ["Content-Type", "Authorization", "X-Amz-Date", "X-Api-Key"],
  exposeHeaders: ["X-Amz-Date"],
  maxAge: Duration.days(1),
};
```

## 🚨 Security Monitoring & Auditing

### CloudWatch Security Monitoring

#### Security Metrics

```typescript
// Failed authentication attempts
const failedAuthMetric = new cloudwatch.Metric({
  namespace: "OC-GraphQL/Security",
  metricName: "FailedAuthentications",
  dimensionsMap: {
    ProjectName: projectName,
  },
});

// Unusual query patterns
const suspiciousQueryMetric = new cloudwatch.Metric({
  namespace: "OC-GraphQL/Security",
  metricName: "SuspiciousQueries",
});
```

#### Automated Alerting

```typescript
// Security alerts
const securityAlert = new cloudwatch.Alarm(this, "SecurityAlert", {
  metric: failedAuthMetric,
  threshold: 10,
  evaluationPeriods: 2,
  treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
});

securityAlert.addAlarmAction(
  new cloudwatchActions.SnsAction(
    sns.Topic.fromTopicArn(this, "SecurityTopic", securityTopicArn)
  )
);
```

### AWS CloudTrail Integration

#### API Call Logging

```json
{
  "eventVersion": "1.05",
  "userIdentity": {
    "type": "AssumedRole",
    "principalId": "AROABC123DEFGHIJKLMN:OCG-function-name",
    "arn": "arn:aws:sts::123456789012:assumed-role/OCG-ExecutionRole/OCG-function",
    "accountId": "123456789012"
  },
  "eventTime": "2024-12-15T10:30:00Z",
  "eventSource": "dynamodb.amazonaws.com",
  "eventName": "PutItem",
  "resources": [
    {
      "accountId": "123456789012",
      "type": "AWS::DynamoDB::Table",
      "ARN": "arn:aws:dynamodb:us-east-1:123456789012:table/project"
    }
  ]
}
```

### Lambda Function Security Logging

#### Security Event Logging

```javascript
exports.handler = async (event) => {
  // Log security-relevant information
  console.log("Security Event:", {
    timestamp: new Date().toISOString(),
    function: context.functionName,
    version: context.functionVersion,
    requestId: context.awsRequestId,
    sourceIP: event.requestContext?.identity?.sourceIp,
    userAgent: event.requestContext?.identity?.userAgent,
    arguments: sanitizeForLogging(event.arguments),
  });

  try {
    const result = await processRequest(event);

    // Log successful operations
    console.log("Operation successful:", {
      operation: event.info?.fieldName,
      entityType: extractEntityType(event),
      timestamp: new Date().toISOString(),
    });

    return result;
  } catch (error) {
    // Log security failures
    console.error("Security failure:", {
      error: error.message,
      operation: event.info?.fieldName,
      timestamp: new Date().toISOString(),
      arguments: sanitizeForLogging(event.arguments),
    });

    throw error;
  }
};

function sanitizeForLogging(args) {
  // Remove sensitive data from logs
  const sanitized = { ...args };
  if (sanitized.password) delete sanitized.password;
  if (sanitized.token) delete sanitized.token;
  if (sanitized.apiKey) delete sanitized.apiKey;
  return sanitized;
}
```

## 🔧 Security Best Practices

### Secure Development Practices

#### Input Validation Guidelines

```javascript
// Always validate inputs at multiple layers
function validateUserInput(input) {
  // 1. Type validation
  if (typeof input.email !== "string") {
    throw new Error("Invalid email type");
  }

  // 2. Format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(input.email)) {
    throw new Error("Invalid email format");
  }

  // 3. Length validation
  if (input.email.length > 254) {
    throw new Error("Email too long");
  }

  // 4. Content validation
  if (input.email.includes("<script>")) {
    throw new Error("Invalid email content");
  }

  return input;
}
```

#### Error Handling Security

```javascript
exports.handler = async (event) => {
  try {
    return await processRequest(event);
  } catch (error) {
    // Log detailed error for debugging
    console.error("Detailed error:", error);

    // Return generic error to client (don't expose internals)
    if (error.message.includes("permission")) {
      throw new Error("Access denied");
    } else if (error.message.includes("not found")) {
      throw new Error("Resource not found");
    } else {
      throw new Error("Internal server error");
    }
  }
};
```

### Security Configuration

#### Environment-Specific Security

```typescript
// Development environment
const devConfig = {
  apiKeyExpiration: Duration.days(30),
  enableDetailedLogging: true,
  allowCrossOriginRequests: true,
};

// Production environment
const prodConfig = {
  apiKeyExpiration: Duration.days(365),
  enableDetailedLogging: false,
  allowCrossOriginRequests: false,
  enableDeletionProtection: true,
  enableBackups: true,
};
```

#### Security Headers

```javascript
// Add security headers to responses
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "X-XSS-Protection": "1; mode=block",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": "default-src 'self'",
};
```

## 🚀 Security Compliance

### Data Protection Compliance

#### GDPR Compliance Features

- **Data Minimization**: Only collect necessary data
- **Right to Deletion**: Automated data cleanup via destroy command
- **Data Portability**: Export capabilities via Athena queries
- **Audit Trails**: Comprehensive logging of all data operations

#### SOC 2 Alignment

- **Security**: Multi-layer security controls
- **Availability**: Auto-scaling and fault tolerance
- **Processing Integrity**: Data validation and error handling
- **Confidentiality**: Encryption and access controls

### Security Auditing Checklist

#### Regular Security Reviews

```bash
# Check for exposed credentials
git log --all --full-history -- "*.env" "*.config" "*.yaml"

# Audit IAM permissions
aws iam get-role-policy --role-name OCG-ExecutionRole --policy-name SecurityPolicy

# Review CloudTrail logs
aws logs filter-log-events --log-group-name /aws/lambda/OCG-function-name --filter-pattern "ERROR"

# Check S3 bucket policies
aws s3api get-bucket-policy --bucket project-bucket-name

# Validate encryption settings
aws dynamodb describe-table --table-name project-table --query "Table.SSEDescription"
```

#### Penetration Testing Guidelines

1. **SQL Injection Testing**: Verify all parameter sanitization
2. **Authentication Bypass**: Test API key and IAM controls
3. **Data Exposure**: Verify encryption and access controls
4. **DDoS Resilience**: Test rate limiting and auto-scaling

---

This comprehensive security framework ensures enterprise-grade protection while maintaining the flexibility and performance characteristics of the OC-GraphQL platform.
