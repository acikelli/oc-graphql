# Lambda Functions Guide

OC-GraphQL automatically generates a comprehensive set of Lambda functions to handle all GraphQL operations. This guide explains the function types, execution patterns, and configuration details.

## 🏗️ Function Architecture Overview

### Function Categories

1. **CRUD Functions** - Basic entity operations (Create, Read, Update, Delete)
2. **Query Functions** - Custom SQL query execution
3. **Mutation Functions** - Custom SQL mutations
4. **Resolver Functions** - Complex type resolution with multiple SQL queries
5. **Field Resolver Functions** - Individual field-level SQL queries
6. **Stream Processor** - DynamoDB to Parquet data pipeline

## 📋 Function Naming Patterns

### Consistent Naming Convention

```
Pattern: OCG-{project}-{category}-{identifier}
Examples:
- OCG-blog-create-user
- OCG-blog-query-getPopularPosts
- OCG-blog-resolver-postconnection
- OCG-blog-stream-processor
```

## 🔧 Function Types & Implementation

### 1. CRUD Functions (Node.js 18.x)

Auto-generated for each entity type to handle basic database operations.

#### Create Function

```javascript
// Pattern: OCG-{project}-create-{entity}
// Example: OCG-blog-create-user

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");
const { v4: uuidv4 } = require("uuid");

exports.handler = async (event) => {
  const input = event.arguments.input;
  const id = uuidv4();
  const now = new Date().toISOString();

  const item = {
    PK: `user#${id}`,
    SK: `user#${id}`,
    id,
    ...input,
    entityType: "user",
    createdAt: now,
    updatedAt: now,
  };

  await dynamoClient.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(item),
    })
  );

  return item;
};
```

#### Read Function

```javascript
// Pattern: OCG-{project}-read-{entity}
// Example: OCG-blog-read-user

const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

exports.handler = async (event) => {
  const id = event.arguments.id;

  const result = await dynamoClient.send(
    new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `user#${id}` },
        SK: { S: `user#${id}` },
      },
    })
  );

  if (!result.Item) {
    throw new Error("User not found");
  }

  return unmarshall(result.Item);
};
```

#### Update Function

```javascript
// Pattern: OCG-{project}-update-{entity}
// Example: OCG-blog-update-user

exports.handler = async (event) => {
  const id = event.arguments.id;
  const input = event.arguments.input;
  const now = new Date().toISOString();

  // Dynamic update expression generation
  const updateExpression = [];
  const expressionAttributeValues = { ":updatedAt": { S: now } };
  const expressionAttributeNames = { "#updatedAt": "updatedAt" };

  Object.entries(input).forEach(([key, value], index) => {
    if (value !== undefined) {
      const attrName = `#attr${index}`;
      const attrValue = `:val${index}`;
      updateExpression.push(`${attrName} = ${attrValue}`);
      expressionAttributeNames[attrName] = key;
      expressionAttributeValues[attrValue] = marshall(value);
    }
  });

  await dynamoClient.send(
    new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: { PK: { S: `user#${id}` }, SK: { S: `user#${id}` } },
      UpdateExpression: `SET ${updateExpression.join(", ")}`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
    })
  );

  return { id, ...input, updatedAt: now };
};
```

#### Delete Function

```javascript
// Pattern: OCG-{project}-delete-{entity}
// Example: OCG-blog-delete-user

exports.handler = async (event) => {
  const id = event.arguments.id;

  await dynamoClient.send(
    new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: `user#${id}` },
        SK: { S: `user#${id}` },
      },
    })
  );

  return { id, deleted: true };
};
```

### 2. Query Functions (Node.js 18.x)

Execute custom SQL queries for complex data retrieval.

```javascript
// Pattern: OCG-{project}-query-{queryName}
// Example: OCG-blog-query-getPopularPosts

const {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} = require("@aws-sdk/client-athena");

// SQL injection prevention
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return "NULL";
  } else if (typeof value === "number") {
    if (!isFinite(value)) {
      throw new Error("Invalid number value");
    }
    return value.toString();
  } else if (typeof value === "boolean") {
    return value ? "true" : "false";
  } else if (typeof value === "string") {
    let escaped = value.split("'").join("''"); // SQL standard escaping
    return "'" + escaped + "'";
  } else {
    throw new Error("Unsupported data type for SQL parameter");
  }
}

exports.handler = async (event) => {
  let query = `SELECT p.*, COUNT(pl.id) as like_count 
               FROM post p 
               LEFT JOIN post_likes pl ON p.id = pl.post_id 
               WHERE p.published = true
                 AND p.created_at >= current_date - interval '$args.days' day
               GROUP BY p.id 
               ORDER BY like_count DESC 
               LIMIT $args.limit`;

  // Replace parameter placeholders with SQL-safe escaping
  if (event.arguments) {
    Object.entries(event.arguments).forEach(([key, value]) => {
      const argsPattern = "$args." + key;
      const sqlSafeValue = escapeSqlValue(value);
      query = query.split(argsPattern).join(sqlSafeValue);
    });
  }

  // Execute Athena query
  const queryExecution = await athenaClient.send(
    new StartQueryExecutionCommand({
      QueryString: query,
      QueryExecutionContext: { Database: DATABASE_NAME },
      ResultConfiguration: { OutputLocation: S3_OUTPUT_LOCATION },
    })
  );

  // Wait for completion and return results
  // ... (polling and result processing logic)

  return data; // Array of results
};
```

### 3. Resolver Functions (Node.js 18.x)

Handle complex types with multiple SQL queries executed in parallel.

```javascript
// Pattern: OCG-{project}-resolver-{typeName}
// Example: OCG-blog-resolver-postconnection

exports.handler = async (event) => {
  const sourceArgs = event.source || {};
  const fieldArgs = event.arguments || {};

  // Determine which field is being requested
  const requestedField = event.info?.fieldName;

  // Execute multiple SQL queries in parallel
  const queryPromises = [
    executeQuery(
      `SELECT * FROM post WHERE user_id = $source.id ORDER BY created_at DESC LIMIT $args.limit OFFSET $args.offset`,
      { ...sourceArgs, ...fieldArgs }
    ).then((result) => ({ field: "items", result: result })),

    executeQuery(
      `SELECT COUNT(*) as count FROM post WHERE user_id = $source.id`,
      { ...sourceArgs, ...fieldArgs }
    ).then((result) => ({
      field: "totalCount",
      result: result[0]["count"] || 0,
    })),
  ];

  const results = await Promise.all(queryPromises);

  // Build response object
  const response = {};
  results.forEach(({ field, result }) => {
    response[field] = result;
  });

  // Handle @return directives
  response.hasMore = fieldArgs.offset + fieldArgs.limit < response.totalCount;

  // Return only the requested field value
  if (requestedField && response.hasOwnProperty(requestedField)) {
    return response[requestedField];
  }

  return response;
};
```

### 4. Field Resolver Functions (Node.js 18.x)

Execute SQL queries for individual fields within regular entity types.

```javascript
// Pattern: OCG-{project}-field-{typeName}-{fieldName}
// Example: OCG-blog-field-user-totalPosts

exports.handler = async (event) => {
  let query = `SELECT COUNT(*) as count FROM post WHERE user_id = $source.id`;

  // Replace source parameters
  if (event.source) {
    Object.entries(event.source).forEach(([key, value]) => {
      const sourcePattern = "$source." + key;
      const sqlSafeValue = escapeSqlValue(value);
      query = query.split(sourcePattern).join(sqlSafeValue);
    });
  }

  // Execute query and return scalar result
  const results = await executeQuery(query, event.source || {});
  return results[0]?.count || 0;
};
```

### 5. Stream Processor (Python 3.11)

Real-time DynamoDB to Parquet conversion with advanced optimization, virtual table support, and automatic Glue table management.

```python
# Pattern: OCG-{project}-stream-processor
# Example: OCG-blog-stream-processor

import json
import os
import boto3
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from datetime import datetime
from io import BytesIO
import logging

# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize AWS clients
s3_client = boto3.client('s3')
glue_client = boto3.client('glue')

BUCKET_NAME = os.environ['S3_BUCKET_NAME']
GLUE_DATABASE = os.environ['ATHENA_DATABASE_NAME']

def lambda_handler(event, context):
    """Main Lambda handler for DynamoDB stream processing"""
    for record in event['Records']:
        try:
            process_record(record)
        except Exception as e:
            logger.error(f"Error processing record: {str(e)}")
            # Continue processing other records
    
    return {'statusCode': 200, 'body': 'Stream processing completed'}

def process_record(record):
    """Process individual DynamoDB stream record"""
    try:
        event_name = record['eventName']  # INSERT, MODIFY, REMOVE
        logger.info(f"Processing DynamoDB event: {event_name}")
        
        current_date = datetime.utcnow()
        year = current_date.strftime('%Y')
        month = current_date.strftime('%m')
        day = current_date.strftime('%d')
        
        if event_name == 'REMOVE':
            handle_delete_operation(record, current_date, year, month, day)
        else:
            handle_insert_update_operation(record, event_name, current_date, year, month, day)
            
    except Exception as e:
        logger.error(f"Error processing stream record: {str(e)}")

def handle_delete_operation(record, current_date, year, month, day):
    """Handle DELETE operations by removing Parquet files from S3"""
    if 'OldImage' not in record.get('dynamodb', {}):
        return
    
    item = unmarshall_dynamodb_item(record['dynamodb']['OldImage'])
    entity_type = item.get('entityType')
    
    if not entity_type:
        return
    
    # Determine S3 key for deletion with date partitioning
    if item.get('virtualTable'):
        # Virtual table: use composite key from PK/SK
        virtual_table = item['virtualTable']
        pk_parts = item['PK'].split('#')
        sk_parts = item['SK'].split('#')
        key_components = pk_parts[2:] + sk_parts[2:]
        key_string = '_'.join(key_components)
        
        # Use original creation date for deletion
        item_date = parse_item_date(item.get('createdAt'), current_date)
        item_year, item_month, item_day = format_date_parts(item_date)
        
        s3_key = f"tables/{virtual_table}/year={item_year}/month={item_month}/day={item_day}/{key_string}.parquet"
    else:
        # Regular entity: use ID
        item_date = parse_item_date(item.get('createdAt'), current_date)
        item_year, item_month, item_day = format_date_parts(item_date)
        
        s3_key = f"tables/{entity_type}/year={item_year}/month={item_month}/day={item_day}/{item['id']}.parquet"
    
    logger.info(f"Deleting S3 object: {s3_key}")
    
    try:
        s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
        logger.info(f"Successfully deleted S3 object: {s3_key}")
    except Exception as e:
        logger.warning(f"S3 object may not exist or already deleted: {s3_key} - {str(e)}")

def handle_insert_update_operation(record, event_name, current_date, year, month, day):
    """Handle INSERT and MODIFY operations by creating/updating Parquet files"""
    image_data = record.get('dynamodb', {}).get('NewImage')
    if not image_data:
        return
    
    item = unmarshall_dynamodb_item(image_data)
    entity_type = item.get('entityType')
    
    if not entity_type:
        return
    
    # Add processing metadata
    item['_processing_timestamp'] = current_date.isoformat()
    item['_event_name'] = event_name
    item['_partition_year'] = year
    item['_partition_month'] = month
    item['_partition_day'] = day
    
    if item.get('virtualTable'):
        handle_virtual_table_item(item, year, month, day, event_name)
    else:
        handle_regular_entity_item(item, entity_type, year, month, day, event_name)

def handle_virtual_table_item(item, year, month, day, event_name):
    """Handle virtual table items (many-to-many relationships) with date partitioning"""
    virtual_table = item['virtualTable']
    pk_parts = item['PK'].split('#')
    sk_parts = item['SK'].split('#')
    
    key_components = pk_parts[2:] + sk_parts[2:]
    key_string = '_'.join(key_components)
    
    s3_key = f"tables/{virtual_table}/year={year}/month={month}/day={day}/{key_string}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{virtual_table}/"
    athena_table_name = virtual_table
    
    logger.info(f"Processing virtual table item for '{virtual_table}' - {event_name}")
    
    # Convert to DataFrame and write as Parquet
    df = create_dataframe_from_item(item)
    write_parquet_to_s3(df, s3_key)
    
    # Ensure Glue table exists with Parquet format
    ensure_optimized_glue_table(athena_table_name, table_location, item, df)

def handle_regular_entity_item(item, entity_type, year, month, day, event_name):
    """Handle regular entity items with date partitioning"""
    s3_key = f"tables/{entity_type}/year={year}/month={month}/day={day}/{item['id']}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{entity_type}/"
    athena_table_name = entity_type
    
    logger.info(f"Processing regular entity item for '{entity_type}' - {event_name}")
    
    # Convert to DataFrame and write as Parquet
    df = create_dataframe_from_item(item)
    write_parquet_to_s3(df, s3_key)
    
    # Ensure Glue table exists with Parquet format
    ensure_optimized_glue_table(athena_table_name, table_location, item, df)

def create_dataframe_from_item(item):
    """Convert DynamoDB item to pandas DataFrame with intelligent type optimization"""
    df = pd.DataFrame([item])
    
    # Optimize data types with proper timestamp handling
    for column in df.columns:
        if column.startswith('_partition_'):
            continue
            
        # Only handle timestamp fields if they are actual ISO 8601 timestamps (AWSDateTime)
        if (isinstance(df[column].iloc[0], str) and is_iso_timestamp(df[column].iloc[0])):
            try:
                # Convert ISO 8601 timestamp to pandas datetime with UTC timezone
                df[column] = pd.to_datetime(df[column], format='mixed', utc=True)
                logger.info(f"Converted AWSDateTime field '{column}' to datetime")
            except Exception as e:
                logger.warning(f"Failed to convert timestamp field '{column}': {e}")
                df[column] = df[column].astype('string')
        
        # Optimize numeric types
        elif df[column].dtype == 'object':
            try:
                numeric_series = pd.to_numeric(df[column], errors='ignore')
                if not numeric_series.equals(df[column]):
                    if numeric_series.dtype == 'int64':
                        df[column] = numeric_series.astype('int32')
                    elif numeric_series.dtype == 'float64':
                        df[column] = numeric_series.astype('float32')
                    else:
                        df[column] = numeric_series
                else:
                    df[column] = df[column].astype('string')
            except:
                df[column] = df[column].astype('string')
        
        # Convert other types to minimal representations
        elif df[column].dtype == 'int64':
            df[column] = df[column].astype('int32')
        elif df[column].dtype == 'float64':
            df[column] = df[column].astype('float32')
    
    return df

def is_iso_timestamp(value):
    """Check if a string value is an ISO 8601 timestamp"""
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except:
        return False

def write_parquet_to_s3(df, s3_key):
    """Write DataFrame as optimized Parquet to S3 with ultra-minimal schema"""
    try:
        # Convert DataFrame to PyArrow table
        table = pa.Table.from_pandas(df, preserve_index=False)
        
        # Create ultra-minimal schema for maximum compression
        ultra_minimal_schema = []
        for i, field in enumerate(table.schema):
            col_data = table.column(i).to_pylist()
            
            # Handle timestamp fields with native timestamp type
            if pd.api.types.is_datetime64_any_dtype(df.iloc[:, i]):
                minimal_field = pa.field(field.name, pa.timestamp('ns', tz='UTC'))
            elif all(isinstance(x, str) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.string())
            elif all(isinstance(x, bool) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.bool_())
            elif all(isinstance(x, int) or x is None for x in col_data):
                max_val = max((abs(x) for x in col_data if x is not None), default=0)
                if max_val < 128:
                    minimal_field = pa.field(field.name, pa.int8())
                elif max_val < 32768:
                    minimal_field = pa.field(field.name, pa.int16())
                else:
                    minimal_field = pa.field(field.name, pa.int32())
            elif all(isinstance(x, float) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.float32())
            else:
                minimal_field = pa.field(field.name, pa.string())
            
            ultra_minimal_schema.append(minimal_field)
        
        # Create table with ultra-minimal schema
        minimal_table = pa.table([table.column(i) for i in range(len(ultra_minimal_schema))], 
                                schema=pa.schema(ultra_minimal_schema))
        
        # Write optimized Parquet with SNAPPY compression
        parquet_buffer = BytesIO()
        pq.write_table(
            minimal_table, 
            parquet_buffer,
            compression='snappy',
            use_dictionary=False,
            write_statistics=False,
            version='2.6'
        )
        parquet_buffer.seek(0)
        
        # Upload to S3
        s3_client.put_object(
            Bucket=BUCKET_NAME,
            Key=s3_key,
            Body=parquet_buffer.getvalue(),
            ContentType='application/octet-stream'
        )
        
        parquet_size = len(parquet_buffer.getvalue())
        logger.info(f"Successfully wrote optimized Parquet: {s3_key} ({parquet_size} bytes)")
        
    except Exception as e:
        logger.error(f"Error writing Parquet to S3: {str(e)}")
        raise

def ensure_optimized_glue_table(table_name, location, sample_item, df):
    """Create or update Glue table with Parquet format and partition projection"""
    try:
        glue_client.get_table(DatabaseName=GLUE_DATABASE, Name=table_name)
        logger.info(f"Table '{table_name}' already exists")
        return
    except glue_client.exceptions.EntityNotFoundException:
        logger.info(f"Creating new Parquet table: {table_name}")
        create_parquet_glue_table(table_name, location, sample_item, df)

def create_parquet_glue_table(table_name, location, sample_item, df):
    """Create optimized Parquet Glue table with partition projection"""
    # Generate columns from DataFrame dtypes (more accurate than sample item)
    columns = []
    for column_name in df.columns:
        if column_name.startswith('_partition_'):
            continue
            
        column_type = infer_glue_type_from_dataframe(df, column_name)
        columns.append({
            'Name': column_name,
            'Type': column_type
        })
    
    # Add partition columns
    partition_keys = [
        {'Name': 'year', 'Type': 'string'},
        {'Name': 'month', 'Type': 'string'},
        {'Name': 'day', 'Type': 'string'}
    ]
    
    # Build storage template for partition projection
    storage_template = f"{location}year=${{year}}/month=${{month}}/day=${{day}}/"
    
    # Create Parquet table with partition projection
    glue_client.create_table(
        DatabaseName=GLUE_DATABASE,
        TableInput={
            'Name': table_name,
            'Description': f'Optimized Parquet table for {table_name} with SNAPPY compression',
            'PartitionKeys': partition_keys,
            'StorageDescriptor': {
                'Columns': columns,
                'Location': location,
                'InputFormat': 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetInputFormat',
                'OutputFormat': 'org.apache.hadoop.hive.ql.io.parquet.MapredParquetOutputFormat',
                'SerdeInfo': {
                    'SerializationLibrary': 'org.apache.hadoop.hive.ql.io.parquet.serde.ParquetHiveSerDe'
                },
                'Parameters': {
                    'parquet.compression': 'SNAPPY',
                    'classification': 'parquet'
                }
            },
            'TableType': 'EXTERNAL_TABLE',
            'Parameters': {
                'EXTERNAL': 'TRUE',
                'parquet.compression': 'SNAPPY',
                'projection.enabled': 'true',
                'projection.year.type': 'integer',
                'projection.year.range': '2024,2030',
                'projection.month.type': 'integer',
                'projection.month.range': '1,12',
                'projection.month.digits': '2',
                'projection.day.type': 'integer',
                'projection.day.range': '1,31',
                'projection.day.digits': '2',
                'storage.location.template': storage_template,
                'has_encrypted_data': 'false',
                'typeOfData': 'file'
            }
        }
    )
    
    logger.info(f"Successfully created Parquet table '{table_name}' with partition projection")

def infer_glue_type_from_dataframe(df, column_name):
    """Infer Glue data type from DataFrame column dtype"""
    column_dtype = df[column_name].dtype
    
    if pd.api.types.is_datetime64_any_dtype(column_dtype):
        return 'timestamp'
    elif pd.api.types.is_bool_dtype(column_dtype):
        return 'boolean'
    elif pd.api.types.is_integer_dtype(column_dtype):
        return 'bigint'
    elif pd.api.types.is_float_dtype(column_dtype):
        return 'double'
    elif pd.api.types.is_string_dtype(column_dtype) or column_dtype == 'object':
        return 'string'
    else:
        return 'string'

def unmarshall_dynamodb_item(dynamodb_item):
    """Convert DynamoDB item format to regular Python dict"""
    item = {}
    for key, value in dynamodb_item.items():
        if 'S' in value:
            item[key] = value['S']
        elif 'N' in value:
            item[key] = float(value['N']) if '.' in value['N'] else int(value['N'])
        elif 'BOOL' in value:
            item[key] = value['BOOL']
        elif 'L' in value:
            item[key] = [unmarshall_value(v) for v in value['L']]
        elif 'M' in value:
            item[key] = {k: unmarshall_value(v) for k, v in value['M'].items()}
        elif 'NULL' in value:
            item[key] = None
        else:
            item[key] = str(value)
    return item

def unmarshall_value(value):
    """Unmarshall a single DynamoDB value"""
    if 'S' in value:
        return value['S']
    elif 'N' in value:
        return float(value['N']) if '.' in value['N'] else int(value['N'])
    elif 'BOOL' in value:
        return value['BOOL']
    elif 'NULL' in value:
        return None
    else:
        return str(value)

def parse_item_date(date_string, default_date):
    """Parse date string or return default"""
    if not date_string:
        return default_date
    try:
        return datetime.fromisoformat(date_string.replace('Z', '+00:00'))
    except:
        return default_date

def format_date_parts(date_obj):
    """Format date into year, month, day parts"""
    return (
        date_obj.strftime('%Y'),
        date_obj.strftime('%m'),
        date_obj.strftime('%d')
    )
```

**Key Features:**

- **Full CRUD Support**: Handles INSERT, MODIFY, and REMOVE operations
- **Virtual Table Support**: Automatically handles many-to-many relationship tables
- **Intelligent Type Detection**: Converts ISO 8601 timestamps to native datetime, optimizes numeric types
- **Automatic Glue Table Creation**: Creates Parquet tables with partition projection for optimal query performance
- **Date Partitioning**: Organizes data by year/month/day for efficient query pruning
- **Ultra-Minimal Parquet Schema**: Uses smallest possible data types for maximum compression
- **Error Resilience**: Continues processing other records if one fails

## ⚙️ Function Configuration

### Runtime & Memory Allocation

| **Function Type** | **Runtime**  | **Memory** | **Timeout** | **Concurrency** |
| ----------------- | ------------ | ---------- | ----------- | --------------- |
| CRUD Operations   | Node.js 18.x | 128 MB     | 30 seconds  | 1000            |
| SQL Queries       | Node.js 18.x | 256 MB     | 5 minutes   | 100             |
| Resolvers         | Node.js 18.x | 512 MB     | 5 minutes   | 100             |
| Stream Processor  | Python 3.11  | 1024 MB    | 5 minutes   | 10              |

### Environment Variables

All functions receive these environment variables:

```bash
DYNAMODB_TABLE_NAME={project}
S3_BUCKET_NAME={project}-{account-id}
ATHENA_DATABASE_NAME={project}_db
ATHENA_OUTPUT_LOCATION=s3://{project}-athena-results-{account-id}/query-results/
AWS_REGION={region}
```

### IAM Permissions

#### CRUD Functions

```json
{
  "Effect": "Allow",
  "Action": [
    "dynamodb:GetItem",
    "dynamodb:PutItem",
    "dynamodb:UpdateItem",
    "dynamodb:DeleteItem"
  ],
  "Resource": "arn:aws:dynamodb:{region}:{account}:table/{project}"
}
```

#### Query/Resolver Functions

```json
{
  "Effect": "Allow",
  "Action": [
    "athena:StartQueryExecution",
    "athena:GetQueryExecution",
    "athena:GetQueryResults",
    "glue:GetTable",
    "glue:GetDatabase"
  ],
  "Resource": "*"
}
```

#### Stream Processor

```json
{
  "Effect": "Allow",
  "Action": [
    "s3:PutObject",
    "s3:DeleteObject",
    "s3:GetObject",
    "glue:CreateTable",
    "glue:GetTable"
  ],
  "Resource": [
    "arn:aws:s3:::{project}-{account}/*",
    "arn:aws:glue:{region}:{account}:*"
  ]
}
```

## 🚀 Performance Optimization

### Cold Start Mitigation

```javascript
// Connection reuse across invocations
const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  maxAttempts: 3,
  retryMode: "adaptive",
});

// Optimize SDK imports
const { GetItemCommand } = require("@aws-sdk/client-dynamodb");
```

### Memory Optimization

```javascript
// Efficient data processing
exports.handler = async (event) => {
  try {
    const result = await processEvent(event);
    return result;
  } catch (error) {
    console.error("Error:", error);
    throw error;
  } finally {
    // Cleanup resources if needed
  }
};
```

### Parallel Execution

```javascript
// Resolver functions execute queries in parallel
const queryPromises = [
  executeQuery(query1, params),
  executeQuery(query2, params),
  executeQuery(query3, params),
];

const results = await Promise.all(queryPromises);
```

## 📊 Monitoring & Debugging

### CloudWatch Metrics

- **Duration**: Function execution time
- **Errors**: Error count and rate
- **Throttles**: Concurrency limit hits
- **Cold Starts**: First-time execution delays

### Logging Strategy

```javascript
exports.handler = async (event) => {
  console.log("Function started:", JSON.stringify(event, null, 2));

  try {
    const result = await processEvent(event);
    console.log("Function completed successfully");
    return result;
  } catch (error) {
    console.error("Function failed:", error);
    throw error;
  }
};
```

### X-Ray Tracing

```javascript
const AWSXRay = require("aws-xray-sdk-core");
const AWS = AWSXRay.captureAWS(require("aws-sdk"));

// Automatic distributed tracing across all services
```

## 🔧 Custom Function Patterns

### Error Handling

```javascript
exports.handler = async (event) => {
  try {
    // Validate input
    if (!event.arguments?.id) {
      throw new Error("Missing required argument: id");
    }

    // Execute operation
    const result = await performOperation(event.arguments);

    return result;
  } catch (error) {
    console.error("Error processing request:", error);

    if (error.message.includes("not found")) {
      throw new Error("Resource not found");
    } else if (error.message.includes("validation")) {
      throw new Error("Invalid input parameters");
    } else {
      throw new Error("Internal server error");
    }
  }
};
```

### Caching Strategy

```javascript
const cache = new Map();

exports.handler = async (event) => {
  const cacheKey = JSON.stringify(event.arguments);

  // Check cache first
  if (cache.has(cacheKey)) {
    console.log("Cache hit");
    return cache.get(cacheKey);
  }

  // Execute query
  const result = await executeQuery(event);

  // Cache result (with TTL)
  cache.set(cacheKey, result);
  setTimeout(() => cache.delete(cacheKey), 300000); // 5 minutes

  return result;
};
```

## 📈 Scaling Considerations

### Concurrency Limits

- **CRUD Operations**: High concurrency (1000+) for fast operations
- **Analytics Queries**: Lower concurrency (100) for resource-intensive operations
- **Stream Processor**: Controlled concurrency (10) for stable data processing

### Cost Optimization

- **Right-sized Memory**: Minimize memory allocation for faster cold starts
- **Efficient Code**: Minimize dependencies and optimize data processing
- **Connection Reuse**: Leverage connection pooling across invocations

---

This comprehensive function architecture provides scalable, efficient, and maintainable serverless GraphQL operations while maintaining optimal performance and cost characteristics.
