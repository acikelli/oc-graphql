import {
  SchemaMetadata,
  TypeMetadata,
  FieldMetadata,
} from "../parsers/schema-parser";

export interface GeneratedCode {
  lambdaFunctions: Record<string, string>;
  processedSchema: string;
}

export class CodeGenerator {
  constructor(
    private schemaMetadata: SchemaMetadata,
    private projectName: string
  ) {}

  async generateAll(): Promise<GeneratedCode> {
    const lambdaFunctions: Record<string, string> = {};

    // Generate CRUD functions for each type (skip @task_response types)
    for (const type of this.schemaMetadata.types) {
      if (!type.isPrimitive && !type.isTaskResponse) {
        lambdaFunctions[
          `ocg-${this.projectName}-create-${type.name.toLowerCase()}.js`
        ] = this.generateCreateFunction(type);
        lambdaFunctions[
          `ocg-${this.projectName}-read-${type.name.toLowerCase()}.js`
        ] = this.generateReadFunction(type);
        lambdaFunctions[
          `ocg-${this.projectName}-update-${type.name.toLowerCase()}.js`
        ] = this.generateUpdateFunction(type);
        lambdaFunctions[
          `ocg-${this.projectName}-delete-${type.name.toLowerCase()}.js`
        ] = this.generateDeleteFunction(type);
      }
    }

    // Query fields are automatically tasks - no direct Lambda functions generated
    // Users must use triggerTask... mutations and taskResult... queries instead

    for (const mutation of this.schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        const query = mutation.sqlQuery.query.trim().toUpperCase();
        const isDeleteQuery = query.startsWith("DELETE");

        if (isDeleteQuery) {
          // Generate task mutation and result query for DELETE operations
          lambdaFunctions[
            `ocg-${this.projectName}-mutation-triggerTask${this.capitalizeFirst(mutation.name)}.js`
          ] = this.generateTriggerDeletionTaskMutation(mutation);

          lambdaFunctions[
            `ocg-${this.projectName}-query-taskResult${this.capitalizeFirst(mutation.name)}.js`
          ] = this.generateDeletionTaskResultQuery(mutation);
        } else {
          lambdaFunctions[
            `ocg-${this.projectName}-mutation-${mutation.name}.js`
          ] = this.generateSqlQueryFunction(mutation);
        }
      }
    }

    // Generate DynamoDB stream processor (Python with Parquet support)
    lambdaFunctions[`ocg-${this.projectName}-stream-processor.py`] =
      this.generateStreamProcessor();

    // Generate cascade deletion queue listener Lambda
    lambdaFunctions[`ocg-${this.projectName}-cascade-deletion-listener.js`] =
      this.generateCascadeDeletionListener();

    // Generate deletion queue listener Lambda (for DELETE SQL operations)
    const hasDeleteMutations = this.schemaMetadata.mutations.some((m) => {
      const query = m.sqlQuery?.query.trim().toUpperCase() || "";
      return query.startsWith("DELETE");
    });
    if (hasDeleteMutations) {
      lambdaFunctions[`ocg-${this.projectName}-deletion-listener.js`] =
        this.generateDeletionListener();
    }

    // Generate task functions for queries with @task directive
    for (const query of this.schemaMetadata.queries) {
      if (query.isTask && query.sqlQuery) {
        // Generate triggerTask mutation
        lambdaFunctions[
          `ocg-${this.projectName}-mutation-triggerTask${this.capitalizeFirst(query.name)}.js`
        ] = this.generateTriggerTaskMutation(query);

        // Generate taskResult query
        lambdaFunctions[
          `ocg-${this.projectName}-query-taskResult${this.capitalizeFirst(query.name)}.js`
        ] = this.generateTaskResultQuery(query);
      }
    }

    // Generate EventBridge Lambda for tracking Athena query executions
    lambdaFunctions[`ocg-${this.projectName}-athena-execution-tracker.js`] =
      this.generateAthenaExecutionTracker();

    // Generate processed schema (without custom directives)
    const processedSchema = this.generateProcessedSchema();

    return {
      lambdaFunctions,
      processedSchema,
    };
  }

  private generateCreateFunction(type: TypeMetadata): string {
    const entityType = type.name.toLowerCase();

    return `
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  try {
    const input = event.arguments.input;
    const id = uuidv4();
    const now = new Date().toISOString();
    
    const item = {
      PK: \`${entityType}#\${id}\`,
      SK: \`${entityType}#\${id}\`,
      id,
      ...input,
      entityType: '${entityType}',
      createdAt: now,
      updatedAt: now
    };
    
    await dynamoClient.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(item)
    }));
    
    return item;
  } catch (error) {
    console.error('Error creating ${entityType}:', error);
    throw error;
  }
};
`;
  }

  private generateReadFunction(type: TypeMetadata): string {
    const entityType = type.name.toLowerCase();

    return `
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  try {
    const id = event.arguments.id;
    
    const result = await dynamoClient.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: \`${entityType}#\${id}\` },
        SK: { S: \`${entityType}#\${id}\` }
      }
    }));
    
    if (!result.Item) {
      throw new Error('${type.name} not found');
    }
    
    return unmarshall(result.Item);
  } catch (error) {
    console.error('Error reading ${entityType}:', error);
    throw error;
  }
};
`;
  }

  private generateUpdateFunction(type: TypeMetadata): string {
    const entityType = type.name.toLowerCase();

    return `
const { DynamoDBClient, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  try {
    const id = event.arguments.id;
    const input = event.arguments.input;
    const now = new Date().toISOString();
    
    const updateExpression = [];
    const expressionAttributeValues = {
      ':updatedAt': { S: now }
    };
    const expressionAttributeNames = {};
    
    updateExpression.push('#updatedAt = :updatedAt');
    expressionAttributeNames['#updatedAt'] = 'updatedAt';
    
    Object.entries(input).forEach(([key, value], index) => {
      if (value !== undefined) {
        const attrName = \`#attr\${index}\`;
        const attrValue = \`:val\${index}\`;
        updateExpression.push(\`\${attrName} = \${attrValue}\`);
        expressionAttributeNames[attrName] = key;
        expressionAttributeValues[attrValue] = marshall(value);
      }
    });
    
    await dynamoClient.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: \`${entityType}#\${id}\` },
        SK: { S: \`${entityType}#\${id}\` }
      },
      UpdateExpression: \`SET \${updateExpression.join(', ')}\`,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues
    }));
    
    return { id, ...input, updatedAt: now };
  } catch (error) {
    console.error('Error updating ${entityType}:', error);
    throw error;
  }
};
`;
  }

  private generateDeleteFunction(type: TypeMetadata): string {
    const entityType = type.name.toLowerCase();

    return `
const { DynamoDBClient, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  try {
    const id = event.arguments.id;
    
    await dynamoClient.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: \`${entityType}#\${id}\` },
        SK: { S: \`${entityType}#\${id}\` }
      }
    }));
    
    return { id, deleted: true };
  } catch (error) {
    console.error('Error deleting ${entityType}:', error);
    throw error;
  }
};
`;
  }

  private generateSqlQueryFunction(field: FieldMetadata): string {
    const query = field.sqlQuery!.query;
    const isJoinTable = query.includes("$join_table(");

    return `
const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } = require('@aws-sdk/client-athena');
const { DynamoDBClient, PutItemCommand, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall, unmarshall } = require('@aws-sdk/util-dynamodb');
const { v4: uuidv4 } = require('uuid');

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const DATABASE_NAME = process.env.ATHENA_DATABASE_NAME;
const S3_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION;
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

// SQL injection prevention function
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  } else if (typeof value === 'number') {
    // Validate number to prevent injection via scientific notation or special values
    if (!isFinite(value)) {
      throw new Error('Invalid number value');
    }
    return value.toString();
  } else if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  } else if (typeof value === 'string') {
    // Escape for SQL while preserving user's search intent
    let escaped = value.split("'").join("''"); // SQL standard: escape single quotes
    // Note: We only escape quotes, not remove content, to preserve search terms
    // Athena handles this safely when parameters are properly quoted
    return "'" + escaped + "'";
  } else {
    throw new Error('Unsupported data type for SQL parameter');
  }
}

exports.handler = async (event) => {
  try {
    let query = \`${query}\`;
    
    // Replace parameter placeholders with SQL-safe escaping
    if (event.arguments) {
      Object.entries(event.arguments).forEach(([key, value]) => {
        const argsPattern = '$args.' + key;
        const sourcePattern = '$source.' + key;
        const sqlSafeValue = escapeSqlValue(value);
        query = query.split(argsPattern).join(sqlSafeValue);
        query = query.split(sourcePattern).join(sqlSafeValue);
      });
    }
    
    if (event.source) {
      Object.entries(event.source).forEach(([key, value]) => {
        const sourcePattern = '$source.' + key;
        const sqlSafeValue = escapeSqlValue(value);
        query = query.split(sourcePattern).join(sqlSafeValue);
      });
    }
    
    ${isJoinTable ? this.generateJoinTableLogic() : ""}
    
    // Replace join table references
    query = query.replace(/\\$join_table\\(([^)]+)\\)/g, '$1');
    
    // Execute Athena query
    const queryExecution = await athenaClient.send(new StartQueryExecutionCommand({
      QueryString: query,
      QueryExecutionContext: {
        Database: DATABASE_NAME
      },
      ResultConfiguration: {
        OutputLocation: S3_OUTPUT_LOCATION
      }
    }));
    
    // Wait for query to complete
    const queryExecutionId = queryExecution.QueryExecutionId;
    let status = 'RUNNING';
    
    while (status === 'RUNNING' || status === 'QUEUED') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const result = await athenaClient.send(new GetQueryExecutionCommand({
        QueryExecutionId: queryExecutionId
      }));
      console.log("result:: ",JSON.stringify(result, null, 2));
      status = result.QueryExecution?.Status?.State || 'FAILED';
    }
    
    if (status !== 'SUCCEEDED') {
      throw new Error(\`Query failed with status: \${status}\`);
    }
    
    // Get query results
    const results = await athenaClient.send(new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId
    }));
    
    // For INSERT operations, return Boolean
    const queryUpper = query.trim().toUpperCase();
    if (queryUpper.startsWith("INSERT")) {
      return true;
    }
    
    // Process results
    const rows = results.ResultSet?.Rows || [];
    const headers = rows[0]?.Data?.map(col => col.VarCharValue) || [];
    const data = rows.slice(1).map(row => {
      const obj = {};
      row.Data?.forEach((col, index) => {
        obj[headers[index]] = col.VarCharValue;
      });
      return obj;
    });
    
    return ${field.isList ? "data" : "data[0] || null"};
  } catch (error) {
    console.error('Error executing SQL query:', error);
    throw error;
  }
};
`;
  }

  private generateJoinTableLogic(): string {
    return `
    // Handle join table insert
    if (query.includes('INSERT INTO') && query.includes('$join_table(')) {
      const joinTableMatch = query.match(/\\$join_table\\(([^)]+)\\)/);
      if (joinTableMatch) {
        const tableName = joinTableMatch[1];
        
        // Extract column definitions from INSERT statement (e.g., "userId:User, productId:Product")
        const insertMatch = query.match(/INSERT\\s+INTO\\s+\\$join_table\\([^)]+\\)\\s*\\(([^)]+)\\)/i);
        const columnDefs = insertMatch ? insertMatch[1].split(',').map(col => col.trim()) : [];
        
        // Parse entity type annotations (e.g., "userId:User" -> {column: "userId", entityType: "User"})
        const entityMappings = [];
        const argEntries = Object.entries(event.arguments);
        const now = new Date().toISOString();
        
        columnDefs.forEach(colDef => {
          const parts = colDef.split(':');
          if (parts.length === 2) {
            const columnName = parts[0].trim();
            const entityType = parts[1].trim();
            const value = event.arguments[columnName];
            if (value) {
              entityMappings.push({ column: columnName, entityType, value });
            }
          }
        });
        
        console.log(\`Detected entity mappings for join table \${tableName}:\`, entityMappings);
        
        if (entityMappings.length === 0) {
          throw new Error('No entity type mappings found in join table insert');
        }
        
        // Create deterministic relationId from sorted entity mappings
        // Sort by entityType first, then by value to ensure consistency
        const sortedMappings = [...entityMappings].sort((a, b) => {
          const typeCompare = a.entityType.localeCompare(b.entityType);
          if (typeCompare !== 0) return typeCompare;
          return a.value.localeCompare(b.value);
        });
        
        // Create deterministic ID: tableName|entityType1:value1|entityType2:value2|...
        // Include table name to prevent collisions across different join tables with same entity mappings
        const relationIdParts = sortedMappings.map(m => \`\${m.entityType.toLowerCase()}:\${m.value}\`);
        const relationIdString = \`\${tableName}|\${relationIdParts.join('|')}\`;
        
        // Use crypto to create a deterministic hash (SHA-256, then take first 32 chars)
        const crypto = require('crypto');
        const relationId = crypto.createHash('sha256').update(relationIdString).digest('hex').substring(0, 32);
        
        console.log(\`Generated deterministic relationId: \${relationId} from: \${relationIdString}\`);
        
        // Check if this relation already exists
        const existingItemKey = {
          PK: { S: \`joinTableData#\${relationId}\` },
          SK: { S: \`joinTableData#\${relationId}\` }
        };
        
        const existingItem = await dynamoClient.send(new GetItemCommand({
          TableName: TABLE_NAME,
          Key: existingItemKey
        }));
        
        if (existingItem.Item) {
          // Relation already exists, return Boolean (success) for INSERT operations
          console.log(\`Relation \${relationId} already exists, returning success\`);
          return true;
        }
        
        // Calculate S3 key using relationId as filename
        const currentDate = new Date();
        const year = currentDate.getUTCFullYear();
        const month = String(currentDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(currentDate.getUTCDate()).padStart(2, '0');
        const s3Key = \`tables/\${tableName}/year=\${year}/month=\${month}/day=\${day}/\${relationId}.parquet\`;
        
        // Build a data item for the Parquet file (contains all entity mappings)
        const parquetDataItem = {
          relationId: relationId,
          joinTableName: tableName,
          s3Key: s3Key,
          createdAt: now
        };
        
        // Add all arguments as fields
        argEntries.forEach(([key, value]) => {
          parquetDataItem[key] = value;
        });
        
        // Save joinRelation items for each entity type with new structure
        // PK: joinRelation#entityType#entityId, SK: joinRelation#relationId
        // GSI1-PK: joinRelation#relationId, GSI1-SK: joinRelation#entityType#entityId
        for (const mapping of entityMappings) {
          const entityTypeLower = mapping.entityType.toLowerCase();
          const joinRelationItem = {
            PK: \`joinRelation#\${entityTypeLower}#\${mapping.value}\`,
            SK: \`joinRelation#\${relationId}\`,
            'GSI1-PK': \`joinRelation#\${relationId}\`,
            'GSI1-SK': \`joinRelation#\${entityTypeLower}#\${mapping.value}\`,
            entityType: 'joinRelation',
            relationId: relationId,
            joinTableName: tableName,
            relatedEntityType: entityTypeLower,
            relatedEntityId: mapping.value,
            s3Key: s3Key,
            createdAt: now
          };
          
          console.log(\`Creating joinRelation item for \${entityTypeLower}:\`, joinRelationItem);
          
          await dynamoClient.send(new PutItemCommand({
            TableName: TABLE_NAME,
            Item: marshall(joinRelationItem)
          }));
        }
        
        // Save the Parquet data item (will be processed by stream processor)
        // Use a temporary PK/SK that the stream processor will recognize as a join table item
        const tempItem = {
          PK: \`joinTableData#\${relationId}\`,
          SK: \`joinTableData#\${relationId}\`,
          entityType: tableName,
          joinTable: tableName,
          ...parquetDataItem
        };
        
        // Use conditional put to prevent race conditions (only insert if doesn't exist)
        try {
          await dynamoClient.send(new PutItemCommand({
            TableName: TABLE_NAME,
            Item: marshall(tempItem),
            ConditionExpression: 'attribute_not_exists(PK)'
          }));
          
          console.log(\`Created new join table relation: \${relationId}\`);
        } catch (error) {
          // If item already exists (race condition), fetch and return existing data
          if (error.name === 'ConditionalCheckFailedException') {
            console.log(\`Relation \${relationId} was created concurrently, fetching existing data\`);
            const existingItem = await dynamoClient.send(new GetItemCommand({
              TableName: TABLE_NAME,
              Key: existingItemKey
            }));
            
            if (existingItem.Item) {
              // For INSERT operations, return Boolean (success)
              return true;
            }
          }
          throw error;
        }
        
        // For INSERT operations, return Boolean (success)
        return true;
      }
    }
`;
  }

  // Removed: generateResolverFunction - @resolver directive no longer supported

  private generateStreamProcessor(): string {
    // Build schema mapping: entityType -> { fieldName -> GraphQL type }
    const schemaMapping: Record<string, Record<string, string>> = {};

    for (const type of this.schemaMetadata.types) {
      if (!type.isPrimitive && !type.isTaskResponse) {
        const entityType = type.name.toLowerCase();
        schemaMapping[entityType] = {};

        for (const field of type.fields) {
          // Skip internal fields
          if (
            field.name === "PK" ||
            field.name === "SK" ||
            field.name === "GSI1-PK" ||
            field.name === "GSI1-SK" ||
            field.name === "entityType" ||
            field.name === "entityId" ||
            field.name.startsWith("_partition_")
          ) {
            continue;
          }

          // Store the GraphQL type (remove list and non-null markers for base type)
          const baseType = field.type.replace(/[\[\]!]/g, "").trim();
          schemaMapping[entityType][field.name] = baseType;
        }
      }
    }

    // Also build schema mapping for join tables from mutations
    const joinTableSchemas: Record<string, Record<string, string>> = {};
    for (const mutation of this.schemaMetadata.mutations) {
      if (mutation.sqlQuery?.query) {
        const query = mutation.sqlQuery.query;
        const joinTableMatch = query.match(/\$join_table\(([^)]+)\)/);
        if (joinTableMatch) {
          const tableName = joinTableMatch[1].toLowerCase();
          if (!joinTableSchemas[tableName]) {
            joinTableSchemas[tableName] = {};
          }

          // Extract column definitions from INSERT statement
          const insertMatch = query.match(
            /INSERT\s+INTO\s+\$join_table\([^)]+\)\s*\(([^)]+)\)/i
          );
          if (insertMatch) {
            const columnDefs = insertMatch[1]
              .split(",")
              .map((col) => col.trim());
            for (const colDef of columnDefs) {
              const parts = colDef.split(":");
              if (parts.length === 2) {
                const columnName = parts[0].trim();
                // Find the column type from mutation arguments
                const arg = mutation.arguments?.find(
                  (a) => a.name === columnName
                );
                if (arg) {
                  const baseType = arg.type.replace(/[\[\]!]/g, "").trim();
                  joinTableSchemas[tableName][columnName] = baseType;
                } else {
                  // Default to String for IDs
                  joinTableSchemas[tableName][columnName] = "String";
                }
              }
            }
          }
        }
      }
    }

    const fs = require("fs");
    const path = require("path");

    try {
      // Read the Python stream processor file
      const pythonFilePath = path.join(__dirname, "python-stream-processor.py");
      let pythonCode = fs.readFileSync(pythonFilePath, "utf8");

      // Inject schema mapping into Python code
      pythonCode = pythonCode.replace(
        /# SCHEMA_MAPPING_PLACEHOLDER/,
        `# Schema mapping from GraphQL types
SCHEMA_MAPPING = ${JSON.stringify(schemaMapping, null, 2)}
JOIN_TABLE_SCHEMAS = ${JSON.stringify(joinTableSchemas, null, 2)}`
      );

      return pythonCode;
    } catch (error) {
      // Fallback inline Python code based on the JavaScript version
      return `
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
sqs_client = boto3.client('sqs')

BUCKET_NAME = os.environ['S3_BUCKET_NAME']
CASCADE_DELETION_QUEUE_URL = os.environ.get('CASCADE_DELETION_QUEUE_URL')

# Schema mapping from GraphQL types
SCHEMA_MAPPING = ${JSON.stringify(schemaMapping, null, 2)}
JOIN_TABLE_SCHEMAS = ${JSON.stringify(joinTableSchemas, null, 2)}

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
        hour = current_date.strftime('%H')
        
        if event_name == 'REMOVE':
            handle_delete_operation(record, current_date, year, month, day)
        else:
            handle_insert_update_operation(record, event_name, current_date, year, month, day)
            
    except Exception as e:
        logger.error(f"Error processing stream record: {str(e)}")

def handle_delete_operation(record, current_date, year, month, day):
    """Handle DELETE operations by removing Parquet files and triggering cascade deletion"""
    # Handle DELETE operations
    if 'OldImage' not in record.get('dynamodb', {}):
        return
    
    item = unmarshall_dynamodb_item(record['dynamodb']['OldImage'])
    entity_type = item.get('entityType')
    
    if not entity_type:
        return
    
    # Skip task entities - they are metadata only and should not trigger S3 deletion
    if entity_type == 'task':
        logger.info(f"Skipping deletion of task entity (metadata only): {item.get('PK')}")
        return
    
    # Skip temporary joinTableData items - they are cleaned up after processing and shouldn't trigger S3 deletion
    if item.get('PK', '').startswith('joinTableData#'):
        logger.info(f"Skipping deletion of temporary joinTableData item: {item.get('PK')}")
        return
    
    # Skip joinRelation items - they are metadata items and their deletion is handled by cascade deletion
    # Processing them here would cause infinite loops (deleting joinRelation items creates new DELETE events)
    if item.get('entityType') == 'joinRelation':
        logger.info(f"Skipping deletion of joinRelation metadata item: {item.get('PK')}")
        return
    
    # Determine S3 key for deletion with date partitioning
    if item.get('joinTable'):
        # Legacy join table item - delete S3 file
        join_table = item['joinTable']
        pk_parts = item['PK'].split('#')
        sk_parts = item['SK'].split('#')
        key_components = pk_parts[2:] + sk_parts[2:]
        key_string = '_'.join(key_components)
        item_date = parse_item_date(item.get('createdAt'), current_date)
        item_year, item_month, item_day = format_date_parts(item_date)
        s3_key = f"tables/{join_table}/year={item_year}/month={item_month}/day={item_day}/{key_string}.parquet"
        
        logger.info(f"Deleting legacy join table S3 object: {s3_key}")
        
        # Delete from S3
        try:
            s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
            logger.info(f"Successfully deleted legacy join table S3 object: {s3_key}")
        except Exception as e:
            logger.warning(f"S3 object may not exist or already deleted: {s3_key} - {str(e)}")
    else:
        # Regular entity deletion - delete S3 file and trigger cascade deletion
        item_date = parse_item_date(item.get('createdAt'), current_date)
        item_year, item_month, item_day = format_date_parts(item_date)
        
        s3_key = f"tables/{entity_type}/year={item_year}/month={item_month}/day={item_day}/{item['id']}.parquet"
        
        logger.info(f"Deleting entity S3 object: {s3_key}")
        
        # Delete from S3
        try:
            s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
            logger.info(f"Successfully deleted entity S3 object: {s3_key}")
        except Exception as e:
            logger.warning(f"S3 object may not exist or already deleted: {s3_key} - {str(e)}")
        
        # Send message to SQS for cascade deletion of join relations
        send_cascade_deletion_message(entity_type, item.get('id'))

def handle_insert_update_operation(record, event_name, current_date, year, month, day):
    """Handle INSERT and MODIFY operations by creating/updating Parquet files"""
    # Handle INSERT and MODIFY operations
    image_data = record.get('dynamodb', {}).get('NewImage')
    if not image_data:
        return
    
    item = unmarshall_dynamodb_item(image_data)
    entity_type = item.get('entityType')
    
    if not entity_type:
        return
    
    # Skip task entities - they are metadata only and should not be written to Parquet
    if entity_type == 'task':
        logger.info(f"Skipping task entity (metadata only): {item.get('PK')}")
        return
    
    # Extract date from item's createdAt for partitioning (use createdAt date, not current date)
    # This ensures updates go to the same partition as the original creation
    item_date = parse_item_date(item.get('createdAt'), current_date)
    item_year, item_month, item_day = format_date_parts(item_date)
    
    # Add processing metadata
    item['_processing_timestamp'] = current_date.isoformat()
    item['_event_name'] = event_name
    item['_partition_year'] = item_year
    item['_partition_month'] = item_month
    item['_partition_day'] = item_day
    
    # Check if this is a join table data item (joinTableData#relationId)
    if item.get('PK', '').startswith('joinTableData#'):
        handle_join_table_data_item(item, item_year, item_month, item_day, event_name)
    elif item.get('joinTable'):
        # Legacy join table item (should not be created anymore, but handle for backwards compatibility)
        handle_legacy_join_table_item(item, item_year, item_month, item_day, event_name)
    else:
        handle_regular_entity_item(item, entity_type, item_year, item_month, item_day, event_name)

def handle_join_table_data_item(item, year, month, day, event_name):
    """Handle join table data items using relationId as filename"""
    join_table = item.get('joinTableName') or item.get('joinTable')
    relation_id = item.get('relationId')
    
    if not relation_id:
        logger.warning(f"Join table item missing relationId: {item}")
        return
    
    if not join_table:
        logger.warning(f"Join table item missing joinTableName: {item}")
        return
    
    s3_key = f"tables/{join_table}/year={year}/month={month}/day={day}/{relation_id}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{join_table}/"
    athena_table_name = join_table
    
    logger.info(f"Processing join table data item for '{join_table}' with relationId '{relation_id}' - {event_name}")
    
    # Convert to DataFrame and write as Parquet
    df = create_dataframe_from_item(item, join_table_name=join_table)
    write_parquet_to_s3(df, s3_key)
    
    
    # Delete the temporary joinTableData item after processing
    # This must happen synchronously to ensure cleanup
    try:
        import boto3.dynamodb.conditions as conditions
        dynamodb_resource = boto3.resource('dynamodb')
        table = dynamodb_resource.Table(TABLE_NAME)
        # Use conditional delete to ensure we only delete if the item still exists
        # This prevents duplicate processing if the item was already deleted
        table.delete_item(
            Key={
                'PK': item['PK'],
                'SK': item['SK']
            },
            ConditionExpression='attribute_exists(PK)'
        )
        logger.info(f"Successfully deleted temporary joinTableData item: {item['PK']}")
    except dynamodb_resource.meta.client.exceptions.ConditionalCheckFailedException:
        # Item was already deleted, skip silently (this is expected in race conditions)
        logger.info(f"joinTableData item {item['PK']} was already deleted, skipping")
    except Exception as e:
        # Log error but don't fail - the Parquet file is already written
        logger.error(f"Error deleting temporary joinTableData item {item['PK']}: {e}")
        # Don't raise - allow processing to continue

def handle_legacy_join_table_item(item, year, month, day, event_name):
    """Handle legacy join table items (for backwards compatibility)"""
    join_table = item['joinTable']
    pk_parts = item['PK'].split('#')
    sk_parts = item['SK'].split('#')
    
    key_components = pk_parts[2:] + sk_parts[2:]
    key_string = '_'.join(key_components)
    
    s3_key = f"tables/{join_table}/year={year}/month={month}/day={day}/{key_string}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{join_table}/"
    athena_table_name = join_table
    
    logger.info(f"Processing legacy join table item for '{join_table}' - {event_name}")
    
    # Convert to DataFrame and write as Parquet
    df = create_dataframe_from_item(item, join_table_name=join_table)
    write_parquet_to_s3(df, s3_key)
    

def handle_regular_entity_item(item, entity_type, year, month, day, event_name):
    """Handle regular entity items with date partitioning"""
    s3_key = f"tables/{entity_type}/year={year}/month={month}/day={day}/{item['id']}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{entity_type}/"
    athena_table_name = entity_type
    
    logger.info(f"Processing regular entity item for '{entity_type}' - {event_name}")
    
    # Convert to DataFrame and write as Parquet
    df = create_dataframe_from_item(item, entity_type=entity_type)
    write_parquet_to_s3(df, s3_key)
    

def create_dataframe_from_item(item, entity_type=None, join_table_name=None):
    """Convert DynamoDB item to pandas DataFrame with proper type handling based on GraphQL schema"""
    # Create DataFrame with single row, minimal metadata
    df = pd.DataFrame([item])
    
    # Determine which schema to use
    schema = None
    if join_table_name:
        schema = JOIN_TABLE_SCHEMAS.get(join_table_name.lower(), {})
    elif entity_type:
        schema = SCHEMA_MAPPING.get(entity_type.lower(), {})
    
    # Optimize data types based on GraphQL schema types
    for column in df.columns:
        if column.startswith('_partition_'):
            continue
        
        # Get expected type from schema
        expected_type = None
        if schema and column in schema:
            expected_type = schema[column]
        
        # Handle timestamp fields (AWSDateTime)
        if expected_type == 'AWSDateTime' or (expected_type is None and isinstance(df[column].iloc[0], str) and is_iso_timestamp(df[column].iloc[0])):
            try:
                # Convert ISO 8601 timestamp to pandas datetime with UTC timezone
                df[column] = pd.to_datetime(df[column], format='mixed', utc=True)
                logger.info(f"Converted AWSDateTime field '{column}' to datetime")
            except Exception as e:
                logger.warning(f"Failed to convert timestamp field '{column}': {e}")
                # Keep as string if conversion fails
                df[column] = df[column].astype('string')
        
        # Handle String/ID types - must stay as string even if numeric-looking
        elif expected_type in ['String', 'ID']:
            df[column] = df[column].astype('string')
            logger.debug(f"Enforcing String type for '{column}' (value: {df[column].iloc[0]})")
        
        # Handle Int types
        elif expected_type == 'Int':
            try:
                numeric_series = pd.to_numeric(df[column], errors='coerce', downcast='integer')
                df[column] = numeric_series.astype('int32')
                logger.debug(f"Converted Int field '{column}' to int32")
            except Exception as e:
                logger.warning(f"Failed to convert Int field '{column}': {e}")
                df[column] = df[column].astype('string')
        
        # Handle Float types
        elif expected_type == 'Float':
            try:
                numeric_series = pd.to_numeric(df[column], errors='coerce', downcast='float')
                df[column] = numeric_series.astype('float32')
                logger.debug(f"Converted Float field '{column}' to float32")
            except Exception as e:
                logger.warning(f"Failed to convert Float field '{column}': {e}")
                df[column] = df[column].astype('string')
        
        # Handle Boolean types
        elif expected_type == 'Boolean':
            df[column] = df[column].astype('bool')
            logger.debug(f"Converted Boolean field '{column}' to bool")
        
        # If no schema type found, infer from data (fallback for backwards compatibility)
        elif expected_type is None:
            if df[column].dtype == 'object':
                # Check if it's a timestamp string
                if isinstance(df[column].iloc[0], str) and is_iso_timestamp(df[column].iloc[0]):
                    try:
                        df[column] = pd.to_datetime(df[column], format='mixed', utc=True)
                    except:
                        df[column] = df[column].astype('string')
                else:
                    # Keep as string if no schema type is defined
                    df[column] = df[column].astype('string')
            elif df[column].dtype == 'bool':
                df[column] = df[column].astype('bool')
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
        # Check for ISO 8601 format like "2025-06-15T13:27:31.659Z"
        datetime.fromisoformat(value.replace('Z', '+00:00'))
        return True
    except:
        return False

def write_parquet_to_s3(df, s3_key):
    """Write DataFrame as optimized Parquet to S3"""
    try:
        # Convert DataFrame to PyArrow table with minimal schema
        table = pa.Table.from_pandas(df, preserve_index=False)
        
        # Create ultra-minimal schema - strip all metadata
        ultra_minimal_schema = []
        for i, field in enumerate(table.schema):
            # Use most compact types possible
            col_data = table.column(i).to_pylist()
            
            # Handle timestamp fields with native timestamp type
            if pd.api.types.is_datetime64_any_dtype(df.iloc[:, i]):
                # Use native timestamp type with nanosecond precision to avoid data loss
                minimal_field = pa.field(field.name, pa.timestamp('ns', tz='UTC'))
                logger.info(f"Creating native timestamp field: {field.name}")
            elif all(isinstance(x, str) or x is None for x in col_data):
                # String data
                minimal_field = pa.field(field.name, pa.string())
            elif all(isinstance(x, bool) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.bool_())
            elif all(isinstance(x, int) or x is None for x in col_data):
                # Use smallest possible integer type
                max_val = max((abs(x) for x in col_data if x is not None), default=0)
                if max_val < 128:
                    minimal_field = pa.field(field.name, pa.int8())
                elif max_val < 32768:
                    minimal_field = pa.field(field.name, pa.int16())
                else:
                    minimal_field = pa.field(field.name, pa.int32())
            elif all(isinstance(x, float) or x is None for x in col_data):
                minimal_field = pa.field(field.name, pa.float32())  # Always use float32
            else:
                minimal_field = pa.field(field.name, pa.string())  # Default to string
            
            ultra_minimal_schema.append(minimal_field)
        
        # Create table with ultra-minimal schema
        minimal_table = pa.table([table.column(i) for i in range(len(ultra_minimal_schema))], 
                                schema=pa.schema(ultra_minimal_schema))
        
        # Write optimized Parquet
        parquet_buffer = BytesIO()
        pq.write_table(
            minimal_table, 
            parquet_buffer,
            compression='snappy',  # Use SNAPPY - universally supported
            use_dictionary=False,  # No dictionary for small files
            write_statistics=False,  # No statistics
            version='2.6'  # Latest version for better compression
        )
        parquet_buffer.seek(0)
        
        # Upload optimized Parquet
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


def infer_glue_type_from_dataframe(df, column_name):
    """Infer Glue data type from DataFrame column dtype"""
    column_dtype = df[column_name].dtype
    
    # Handle datetime columns
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
        return 'string'  # Default fallback

def infer_parquet_glue_type(value):
    """Infer optimal Glue data type for Parquet format (legacy function)"""
    if isinstance(value, str):
        # Only create timestamp type for actual ISO 8601 formatted strings (AWSDateTime)
        if is_iso_timestamp(value):
            return 'timestamp'
        else:
            return 'string'
    elif isinstance(value, bool):
        return 'boolean'
    elif isinstance(value, int):
        return 'bigint'
    elif isinstance(value, float):
        return 'double'
    elif isinstance(value, list):
        return 'array<string>'
    elif isinstance(value, dict):
        return 'struct<>'
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

def send_cascade_deletion_message(entity_type, entity_id):
    """Send message to SQS queue for cascade deletion of join relations"""
    if not CASCADE_DELETION_QUEUE_URL:
        logger.warning("CASCADE_DELETION_QUEUE_URL not set, skipping cascade deletion")
        return
    
    try:
        message = {
            'entityType': entity_type,
            'entityId': entity_id,
            'timestamp': datetime.utcnow().isoformat()
        }
        
        sqs_client.send_message(
            QueueUrl=CASCADE_DELETION_QUEUE_URL,
            MessageBody=json.dumps(message)
        )
        
        logger.info(f"Sent cascade deletion message for {entity_type}#{entity_id}")
    except Exception as e:
        logger.error(f"Error sending cascade deletion message: {str(e)}")
`;
    }
  }

  private generateProcessedSchema(): string {
    // Remove custom directives and add CRUD operations
    let processedSchema = this.schemaMetadata.types
      .filter((type) => !type.isPrimitive)
      .map((type) => this.generateTypeDefinition(type))
      .join("\n\n");

    // Add input types for CRUD operations
    processedSchema += "\n\n" + this.generateInputTypes();

    // Add root types
    processedSchema += "\n\n" + this.generateRootTypes();

    // Add enums
    if (this.schemaMetadata.enums.length > 0) {
      processedSchema +=
        "\n\n" +
        this.schemaMetadata.enums
          .map((enumName) => `enum ${enumName} { ${enumName}_VALUE }`)
          .join("\n\n");
    }

    return processedSchema;
  }

  private generateInputTypes(): string {
    const inputTypes: string[] = [];

    // Generate CreateXInput type
    for (const type of this.schemaMetadata.types) {
      if (!type.isPrimitive && !type.isTaskResponse) {
        const createFields = type.fields
          .filter(
            (field) =>
              !field.sqlQuery &&
              field.name !== "id" &&
              field.name !== "createdAt" &&
              field.name !== "updatedAt" &&
              this.isScalarType(field.type) // Only include scalar types
          )
          .map((field) => {
            const fieldType = field.isList ? `[${field.type}!]` : field.type;
            const isRequired = field.isRequired ? "!" : "";
            return `  ${field.name}: ${fieldType}${isRequired}`;
          })
          .join("\n");

        if (createFields) {
          inputTypes.push(
            `input Create${type.name}Input {\n${createFields}\n}`
          );
        }

        // Generate UpdateXInput type (all fields optional)
        const updateFields = type.fields
          .filter(
            (field) =>
              !field.sqlQuery &&
              field.name !== "id" &&
              field.name !== "createdAt" &&
              field.name !== "updatedAt" &&
              this.isScalarType(field.type) // Only include scalar types
          )
          .map((field) => {
            const fieldType = field.isList ? `[${field.type}!]` : field.type;
            return `  ${field.name}: ${fieldType}`;
          })
          .join("\n");

        if (updateFields) {
          inputTypes.push(
            `input Update${type.name}Input {\n${updateFields}\n}`
          );
        }
      }
    }

    return inputTypes.join("\n\n");
  }

  private isScalarType(type: string): boolean {
    const scalarTypes = [
      "String",
      "Int",
      "Float",
      "Boolean",
      "ID",
      "AWSDateTime",
    ];
    return scalarTypes.includes(type);
  }

  private generateTypeDefinition(type: TypeMetadata): string {
    // For regular types, include only scalar fields (no @sql_query on type fields)
    const fields = type.fields
      .filter((field) => {
        // Include only scalar types (no @sql_query on type fields)
        return this.isScalarType(field.type);
      })
      .map((field) => {
        let fieldType = field.type;

        // Handle list types
        if (field.isList) {
          fieldType = `[${fieldType}!]`;
        }

        // Handle required types
        if (field.isRequired) {
          fieldType = `${fieldType}!`;
        }

        // Include arguments if field has them
        const args = this.generateFieldArguments(field);
        return `  ${field.name}${args}: ${fieldType}`;
      })
      .join("\n");

    return `type ${type.name} {\n${fields}\n}`;
  }

  private generateFieldArguments(field: FieldMetadata): string {
    if (!field.arguments || field.arguments.length === 0) {
      return "";
    }

    const args = field.arguments
      .map((arg) => {
        const argType = arg.isList ? `[${arg.type}!]` : arg.type;
        const required = arg.isRequired ? "!" : "";
        return `${arg.name}: ${argType}${required}`;
      })
      .join(", ");

    return `(${args})`;
  }

  private generateRootTypes(): string {
    const crudQueries = this.schemaMetadata.types
      .filter((type) => !type.isPrimitive && !type.isTaskResponse)
      .map((type) => `  read${type.name}(id: ID!): ${type.name}`)
      .join("\n");

    const crudMutations = this.schemaMetadata.types
      .filter((type) => !type.isPrimitive && !type.isTaskResponse)
      .flatMap((type) => [
        `  create${type.name}(input: Create${type.name}Input!): ${type.name}!`,
        `  update${type.name}(id: ID!, input: Update${type.name}Input!): ${type.name}!`,
        `  delete${type.name}(id: ID!): DeleteResult!`,
      ])
      .join("\n");

    // Original Query fields are not included - they are replaced by triggerTask mutations and taskResult queries
    // All Query fields are automatically tasks, so users must use triggerTask... and taskResult... APIs
    const customQueries = "";

    // Generate custom mutations with their arguments
    // Exclude DELETE mutations - they are handled as triggerTask mutations
    const customMutations = this.schemaMetadata.mutations
      .filter((m) => {
        const query = m.sqlQuery?.query.trim().toUpperCase() || "";
        return !query.startsWith("DELETE");
      })
      .map((m) => {
        const args = m.arguments
          ? m.arguments
              .map((arg) => {
                const argType = arg.isList ? `[${arg.type}!]` : arg.type;
                const required = arg.isRequired ? "!" : "";
                return `${arg.name}: ${argType}${required}`;
              })
              .join(", ")
          : "";
        const argsString = args ? `(${args})` : "";

        // Automatically set return type for INSERT operations
        const query = m.sqlQuery?.query.trim().toUpperCase() || "";
        let returnType: string;
        if (query.startsWith("INSERT")) {
          returnType = "Boolean!";
        } else {
          returnType = m.isList ? `[${m.type}!]` : m.type;
          const required = m.isRequired ? "!" : "";
          returnType += required;
        }

        return `  ${m.name}${argsString}: ${returnType}`;
      })
      .join("\n");

    // Generate task mutations (triggerTask) for queries with @task directive
    const taskMutations = this.schemaMetadata.queries
      .filter((q) => q.isTask && q.sqlQuery)
      .map((q) => {
        const args = q.arguments
          ? q.arguments
              .map((arg) => {
                const argType = arg.isList ? `[${arg.type}!]` : arg.type;
                const required = arg.isRequired ? "!" : "";
                return `${arg.name}: ${argType}${required}`;
              })
              .join(", ")
          : "";
        const argsString = args ? `(${args})` : "";
        return `  triggerTask${this.capitalizeFirst(q.name)}${argsString}: TaskTriggerResult!`;
      })
      .join("\n");

    // Generate task result queries (taskResult) for queries with @task directive
    const taskResultQueries = this.schemaMetadata.queries
      .filter((q) => q.isTask && q.sqlQuery)
      .map((q) => {
        const returnType = q.isList ? `[${q.type}!]` : q.type;
        return `  taskResult${this.capitalizeFirst(q.name)}(taskId: ID!): TaskResult${this.capitalizeFirst(q.name)}!`;
      })
      .join("\n");

    // Generate deletion task mutations and result queries for DELETE mutations
    const deletionTaskMutations = this.schemaMetadata.mutations
      .filter((m) => {
        const query = m.sqlQuery?.query.trim().toUpperCase() || "";
        return query.startsWith("DELETE");
      })
      .map((m) => {
        const args = m.arguments
          ? m.arguments
              .map((arg) => {
                const argType = arg.isList ? `[${arg.type}!]` : arg.type;
                const required = arg.isRequired ? "!" : "";
                return `${arg.name}: ${argType}${required}`;
              })
              .join(", ")
          : "";
        const argsString = args ? `(${args})` : "";
        return `  triggerTask${this.capitalizeFirst(m.name)}${argsString}: TaskTriggerResult!`;
      })
      .join("\n");

    const deletionTaskResultQueries = this.schemaMetadata.mutations
      .filter((m) => {
        const query = m.sqlQuery?.query.trim().toUpperCase() || "";
        return query.startsWith("DELETE");
      })
      .map((m) => {
        return `  taskResult${this.capitalizeFirst(m.name)}(taskId: ID!): DeletionTaskResult!`;
      })
      .join("\n");

    return `
type Query {
${crudQueries}
${taskResultQueries}
${deletionTaskResultQueries}
}

type Mutation {
${crudMutations}
${customMutations}
${taskMutations}
${deletionTaskMutations}
}

type DeleteResult {
  id: ID!
  deleted: Boolean!
}

type TaskTriggerResult {
  taskId: ID!
}

enum TaskStatus {
  RUNNING
  SUCCEEDED
  FAILED
}

type DeletionTaskResult {
  taskStatus: TaskStatus!
  startDate: AWSDateTime!
  finishDate: AWSDateTime
}

${this.schemaMetadata.queries
  .filter((q) => q.isTask && q.sqlQuery)
  .map((q) => {
    const returnType = q.isList ? `[${q.type}!]` : q.type;
    return `
type TaskResult${this.capitalizeFirst(q.name)} {
  taskStatus: TaskStatus!
  result: ${returnType}
  startDate: AWSDateTime!
  finishDate: AWSDateTime
}`;
  })
  .join("\n")}
`;
  }

  private mapGraphQLTypeToTypeScript(
    graphqlType: string,
    isList: boolean
  ): string {
    const typeMap: Record<string, string> = {
      String: "string",
      Int: "number",
      Float: "number",
      Boolean: "boolean",
      ID: "string",
      AWSDateTime: "string",
    };

    const tsType = typeMap[graphqlType] || graphqlType;
    return isList ? `${tsType}[]` : tsType;
  }

  private capitalizeFirst(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  /**
   * Transform DELETE query to SELECT s3Key and relationId query
   * DELETE queries must use $join_table() wrapper: "DELETE alias FROM $join_table(table_name) alias ..."
   * Example: "DELETE ufp FROM $join_table(user_favorite_products) ufp INNER JOIN products p ON ufp.productId = p.productId WHERE p.brandId = $args.brandId;"
   * Becomes: "SELECT ufp.s3Key, ufp.relationId FROM user_favorite_products ufp INNER JOIN products p ON ufp.productId = p.productId WHERE p.brandId = $args.brandId;"
   */
  private transformDeleteToSelectS3Key(deleteQuery: string): string {
    // Remove trailing semicolon if present
    let query = deleteQuery.trim().replace(/;\s*$/, "");

    // Validate that DELETE query uses $join_table() wrapper
    if (!query.includes("$join_table(")) {
      throw new Error(
        "DELETE queries must use $join_table() wrapper for table names. Example: DELETE alias FROM $join_table(table_name) alias ..."
      );
    }

    // Match DELETE pattern: DELETE [table_alias] FROM $join_table(table_name) [alias] ...
    // or DELETE FROM $join_table(table_name) [alias] ...
    const deletePattern = /^DELETE\s+(?:\w+\s+)?FROM\s+\$join_table\s*\(/i;

    if (!deletePattern.test(query)) {
      throw new Error(
        "Invalid DELETE query format. Must use: DELETE [alias] FROM $join_table(table_name) [alias] ..."
      );
    }

    // Extract the table alias (if present after DELETE)
    // DELETE ufp FROM ... -> ufp
    // DELETE FROM ... -> need to find alias from FROM clause
    const deleteMatch = query.match(/^DELETE\s+(\w+)?\s+FROM\s+/i);
    const tableAlias = deleteMatch && deleteMatch[1] ? deleteMatch[1] : null;

    // Remove DELETE [alias] FROM part
    query = query.replace(/^DELETE\s+(?:\w+\s+)?FROM\s+/i, "");

    // Remove $join_table() wrapper (same as INSERT queries)
    // Pattern: $join_table(table_name) -> table_name
    query = query.replace(/\$join_table\s*\(([^)]+)\)/g, "$1");

    // Find the first table name/alias after FROM
    // This handles: table_name alias or just table_name
    const fromMatch = query.match(/^(\w+)(?:\s+(\w+))?/);
    const actualAlias =
      tableAlias || (fromMatch && fromMatch[2]) || (fromMatch && fromMatch[1]);

    if (!actualAlias) {
      throw new Error("Could not determine table alias for DELETE query");
    }

    // Transform to SELECT s3Key and relationId query
    const selectQuery = `SELECT ${actualAlias}.s3Key, ${actualAlias}.relationId FROM ${query}`;

    return selectQuery;
  }

  private generateTriggerDeletionTaskMutation(mutation: FieldMetadata): string {
    const mutationName = mutation.name;
    const capitalizedMutationName = this.capitalizeFirst(mutationName);
    const originalQuery = mutation.sqlQuery!.query;
    const selectQuery = this.transformDeleteToSelectS3Key(originalQuery);

    // Build arguments string
    const argsString = mutation.arguments
      ? mutation.arguments
          .map((arg) => {
            const argType = arg.isList ? `[${arg.type}!]` : arg.type;
            const required = arg.isRequired ? "!" : "";
            return `${arg.name}: ${argType}${required}`;
          })
          .join(", ")
      : "";

    return `
const { AthenaClient, StartQueryExecutionCommand } = require('@aws-sdk/client-athena');
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const DATABASE_NAME = process.env.ATHENA_DATABASE_NAME;
const S3_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION;
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

// SQL injection prevention function
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  } else if (typeof value === 'number') {
    if (!isFinite(value)) {
      throw new Error('Invalid number value');
    }
    return value.toString();
  } else if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  } else if (typeof value === 'string') {
    let escaped = value.split("'").join("''");
    return "'" + escaped + "'";
  } else {
    throw new Error('Unsupported data type for SQL parameter');
  }
}

exports.handler = async (event) => {
  try {
    console.log('Deletion task mutation event:', JSON.stringify(event, null, 2));
    const now = new Date().toISOString();
    
    // Transform DELETE query to SELECT s3Key query
    let sqlQuery = \`${selectQuery.replace(/\$/g, "\\$")}\`;
    console.log('Transformed SELECT query:', sqlQuery);
    
    // Replace parameter placeholders
    if (event.arguments) {
      Object.entries(event.arguments).forEach(([key, value]) => {
        const argsPattern = '$args.' + key;
        const sqlSafeValue = escapeSqlValue(value);
        sqlQuery = sqlQuery.split(argsPattern).join(sqlSafeValue);
      });
    }
    
    console.log('Final SQL query:', sqlQuery);
    
    // Start Athena query execution
    const queryExecution = await athenaClient.send(new StartQueryExecutionCommand({
      QueryString: sqlQuery,
      QueryExecutionContext: {
        Database: DATABASE_NAME
      },
      ResultConfiguration: {
        OutputLocation: S3_OUTPUT_LOCATION
      },
      ClientRequestToken: 'deletion-task-' + Date.now() + '-' + Math.random().toString(36).substring(7)
    }));
    
    console.log('Athena query execution response:', JSON.stringify(queryExecution, null, 2));
    
    const executionId = queryExecution.QueryExecutionId;
    
    if (!executionId) {
      console.error('QueryExecutionId is missing from Athena response:', queryExecution);
      throw new Error('Failed to start Athena query execution: QueryExecutionId is missing');
    }
    
    // Save task entity with taskType: "deletionTask"
    const taskItem = {
      PK: \`task#\${executionId}\`,
      SK: \`task#\${executionId}\`,
      entityType: 'task',
      taskId: executionId,
      taskType: 'deletionTask',
      mutationName: '${mutationName}',
      taskStatus: 'RUNNING',
      startDate: now,
      finishDate: null,
      createdAt: now,
      updatedAt: now
    };
    
    await dynamoClient.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(taskItem)
    }));
    
    return { taskId: executionId };
  } catch (error) {
    console.error('Error triggering deletion task:', error);
    throw error;
  }
};
`;
  }

  private generateDeletionTaskResultQuery(mutation: FieldMetadata): string {
    const mutationName = mutation.name;
    const capitalizedMutationName = this.capitalizeFirst(mutationName);

    return `
const { DynamoDBClient, GetItemCommand } = require('@aws-sdk/client-dynamodb');
const { AthenaClient, GetQueryExecutionCommand } = require('@aws-sdk/client-athena');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  try {
    const taskId = event.arguments.taskId;
    
    // Get task entity
    const taskResult = await dynamoClient.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: \`task#\${taskId}\` },
        SK: { S: \`task#\${taskId}\` }
      }
    }));
    
    if (!taskResult.Item) {
      throw new Error('Task not found');
    }
    
    const task = unmarshall(taskResult.Item);
    
    // Check execution status
    let taskStatus = 'RUNNING';
    let finishDate = null;
    
    try {
      const execResult = await athenaClient.send(new GetQueryExecutionCommand({
        QueryExecutionId: taskId
      }));
      
      const athenaStatus = execResult.QueryExecution?.Status?.State || 'UNKNOWN';
      const statusChangeDateTime = execResult.QueryExecution?.Status?.StateChangeDateTime;
      
      if (athenaStatus === 'RUNNING' || athenaStatus === 'QUEUED') {
        taskStatus = 'RUNNING';
      } else if (athenaStatus === 'SUCCEEDED') {
        taskStatus = 'SUCCEEDED';
        finishDate = statusChangeDateTime || new Date().toISOString();
      } else if (athenaStatus === 'FAILED' || athenaStatus === 'CANCELLED') {
        taskStatus = 'FAILED';
        finishDate = statusChangeDateTime || new Date().toISOString();
      }
    } catch (error) {
      console.error(\`Error checking execution \${taskId}:\`, error);
      taskStatus = 'FAILED';
    }
    
    return {
      taskStatus: taskStatus,
      startDate: task.startDate,
      finishDate: finishDate
    };
  } catch (error) {
    console.error('Error getting deletion task result:', error);
    throw error;
  }
};
`;
  }

  private countSqlQueriesInQuery(query: FieldMetadata): number {
    // For simple queries with @sql_query, count is 1
    if (query.sqlQuery) {
      return 1;
    }

    // If query returns a resolver type, count SQL queries in that type
    // @resolver directive no longer supported
    return 0;
  }

  private generateTriggerTaskMutation(query: FieldMetadata): string {
    const queryName = query.name;
    const capitalizedQueryName = this.capitalizeFirst(queryName);

    // Build arguments string
    const argsString = query.arguments
      ? query.arguments
          .map((arg) => {
            const argType = arg.isList ? `[${arg.type}!]` : arg.type;
            const required = arg.isRequired ? "!" : "";
            return `${arg.name}: ${argType}${required}`;
          })
          .join(", ")
      : "";

    return `
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { AthenaClient, StartQueryExecutionCommand } = require('@aws-sdk/client-athena');
const { marshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;
const DATABASE_NAME = process.env.ATHENA_DATABASE_NAME;
const S3_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION;

// SQL injection prevention function
function escapeSqlValue(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  } else if (typeof value === 'number') {
    if (!isFinite(value)) {
      throw new Error('Invalid number value');
    }
    return value.toString();
  } else if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  } else if (typeof value === 'string') {
    let escaped = value.split("'").join("''");
    return "'" + escaped + "'";
  } else {
    throw new Error('Unsupported data type for SQL parameter');
  }
}

exports.handler = async (event) => {
  try {
    const now = new Date().toISOString();
    
    // Prepare SQL query with parameter replacement
    let sqlQuery = \`${query.sqlQuery!.query}\`;
    
    // Replace parameter placeholders
    if (event.arguments) {
      Object.entries(event.arguments).forEach(([key, value]) => {
        const argsPattern = '$args.' + key;
        const sqlSafeValue = escapeSqlValue(value);
        sqlQuery = sqlQuery.split(argsPattern).join(sqlSafeValue);
      });
    }
    
    // Replace join table references
    sqlQuery = sqlQuery.replace(/\\$join_table\\(([^)]+)\\)/g, '$1');
    
    // Start Athena query execution
    const queryExecution = await athenaClient.send(new StartQueryExecutionCommand({
      QueryString: sqlQuery,
      QueryExecutionContext: {
        Database: DATABASE_NAME
      },
      ResultConfiguration: {
        OutputLocation: S3_OUTPUT_LOCATION
      }
    }));
    
    // Use execution ID as task ID (only one query per task)
    const taskId = queryExecution.QueryExecutionId;
    
    if (!taskId) {
      throw new Error('Failed to start Athena query execution: QueryExecutionId is missing');
    }
    
    // Create task entity
    const taskItem = {
      PK: \`task#\${taskId}\`,
      SK: \`task#\${taskId}\`,
      id: taskId,
      entityType: 'task',
      entityId: taskId,
      taskStatus: 'RUNNING',
      startDate: now,
      finishDate: null,
      createdAt: now,
      updatedAt: now
    };
    
    await dynamoClient.send(new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshall(taskItem)
    }));
    
    return { taskId };
  } catch (error) {
    console.error('Error triggering task:', error);
    throw error;
  }
};
`;
  }

  private generateTaskResultQuery(query: FieldMetadata): string {
    const queryName = query.name;
    const capitalizedQueryName = this.capitalizeFirst(queryName);
    const returnType = query.isList ? `[${query.type}!]` : query.type;

    // Get the response type metadata to build field mapping
    const responseType = this.schemaMetadata.types.find(
      (t) => t.name === query.type
    );
    const graphQLFields: string[] = [];
    const athenaToGraphQLMap: Record<string, string> = {};

    // Track datetime fields for conversion
    const datetimeFields: string[] = [];

    if (responseType) {
      // Create reverse mapping: lowercase Athena column name -> GraphQL camelCase field name
      responseType.fields.forEach((field) => {
        const graphQLFieldName = field.name;
        const athenaColumnName = field.name.toLowerCase();
        graphQLFields.push(graphQLFieldName);
        athenaToGraphQLMap[athenaColumnName] = graphQLFieldName;

        // Track AWSDateTime fields for format conversion
        if (field.type === "AWSDateTime") {
          datetimeFields.push(graphQLFieldName);
        }
      });
    }

    return `
const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand } = require('@aws-sdk/client-athena');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

// Mapping from Athena lowercase column names to GraphQL camelCase field names
const athenaToGraphQLMap = ${JSON.stringify(athenaToGraphQLMap)};
const graphQLFields = ${JSON.stringify(graphQLFields)};
const datetimeFields = ${JSON.stringify(datetimeFields)};

// Helper function to map Athena column names to GraphQL field names (case-insensitive)
function mapAthenaToGraphQL(athenaColumnName) {
  const lowerColumn = athenaColumnName.toLowerCase();
  // Look up in the mapping
  if (athenaToGraphQLMap[lowerColumn]) {
    return athenaToGraphQLMap[lowerColumn];
  }
  // Fallback: try to find case-insensitive match in GraphQL fields
  for (const graphQLField of graphQLFields) {
    if (graphQLField.toLowerCase() === lowerColumn) {
      return graphQLField;
    }
  }
  // Fallback: return original if no match found
  return athenaColumnName;
}

// Helper function to convert Athena datetime format to ISO 8601
// Athena returns: "2025-12-09 09:38:26.778" (SQL format)
// GraphQL AWSDateTime expects: "2025-12-09T09:38:26.778Z" (ISO 8601)
function convertDateTime(value, fieldName) {
  if (!value || !datetimeFields.includes(fieldName)) {
    return value;
  }
  
  if (typeof value !== 'string') {
    return value;
  }
  
  // If already in ISO format (contains T), check if it has timezone
  if (value.includes('T')) {
    // If it ends with Z or has timezone offset (+/-HH:MM), return as-is
    if (value.endsWith('Z') || /[+-]\\d{2}:\\d{2}$/.test(value)) {
      return value;
    }
    // Add Z if missing timezone
    return value + 'Z';
  }
  
  // Convert SQL datetime format to ISO 8601
  // Format: "2025-12-09 09:38:26.778" -> "2025-12-09T09:38:26.778Z"
  // Replace space with T
  let isoValue = value.replace(' ', 'T');
  
  // Add Z if no timezone indicator present
  if (!isoValue.includes('Z') && !/[+-]\\d{2}:\\d{2}$/.test(isoValue)) {
    isoValue = isoValue + 'Z';
  }
  
  return isoValue;
}

exports.handler = async (event) => {
  try {
    const taskId = event.arguments.taskId;
    
    // Get task entity (taskId is the execution ID)
    const taskResult = await dynamoClient.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: \`task#\${taskId}\` },
        SK: { S: \`task#\${taskId}\` }
      }
    }));
    
    if (!taskResult.Item) {
      throw new Error('Task not found');
    }
    
    let task = unmarshall(taskResult.Item);
    let taskStatus = task.taskStatus || 'RUNNING';
    let finishDate = task.finishDate || null;
    
    // Poll Athena directly for execution status if still RUNNING
    if (taskStatus === 'RUNNING' || taskStatus === 'QUEUED') {
      try {
        const execResult = await athenaClient.send(new GetQueryExecutionCommand({
          QueryExecutionId: taskId
        }));
        
        const status = execResult.QueryExecution?.Status?.State || 'UNKNOWN';
        const statusChangeDateTime = execResult.QueryExecution?.Status?.StateChangeDateTime;
        
        // Map Athena status to task status
        if (status === 'SUCCEEDED') {
          taskStatus = 'SUCCEEDED';
        } else if (status === 'FAILED' || status === 'CANCELLED') {
          taskStatus = 'FAILED';
        } else {
          taskStatus = 'RUNNING';
        }
        
        // Update task entity if status changed
        if (task.taskStatus !== taskStatus) {
          const updateExpression = taskStatus === 'SUCCEEDED' || taskStatus === 'FAILED'
            ? 'SET taskStatus = :status, finishDate = :finishDate, updatedAt = :updatedAt'
            : 'SET taskStatus = :status, updatedAt = :updatedAt';
          
          const expressionAttributeValues = taskStatus === 'SUCCEEDED' || taskStatus === 'FAILED'
            ? {
                ':status': { S: taskStatus },
                ':finishDate': { S: statusChangeDateTime || new Date().toISOString() },
                ':updatedAt': { S: new Date().toISOString() }
              }
            : {
                ':status': { S: taskStatus },
                ':updatedAt': { S: new Date().toISOString() }
              };
          
          await dynamoClient.send(new UpdateItemCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: { S: \`task#\${taskId}\` },
              SK: { S: \`task#\${taskId}\` }
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues
          }));
          
          // Refresh task to get updated finishDate
          const updatedTaskResult = await dynamoClient.send(new GetItemCommand({
            TableName: TABLE_NAME,
            Key: {
              PK: { S: \`task#\${taskId}\` },
              SK: { S: \`task#\${taskId}\` }
            }
          }));
          if (updatedTaskResult.Item) {
            task = unmarshall(updatedTaskResult.Item);
            finishDate = task.finishDate || null;
          }
        }
      } catch (error) {
        console.error(\`Error polling Athena for execution \${taskId}:\`, error);
      }
    }
    
    // Build result if query completed successfully
    let result = null;
    if (taskStatus === 'SUCCEEDED') {
      try {
        const athenaResults = await athenaClient.send(new GetQueryResultsCommand({
          QueryExecutionId: taskId,
          MaxResults: 1000
        }));
        
        const rows = athenaResults.ResultSet?.Rows || [];
        const headers = rows[0]?.Data?.map(col => col.VarCharValue) || [];
        
        const data = rows.slice(1).map(row => {
          const obj = {};
          row.Data?.forEach((col, index) => {
            const athenaColumnName = headers[index] || '';
            // Map Athena column name (lowercase) to GraphQL field name (camelCase)
            const graphQLFieldName = mapAthenaToGraphQL(athenaColumnName);
            let value = col.VarCharValue;
            // Convert datetime fields to ISO 8601 format
            value = convertDateTime(value, graphQLFieldName);
            obj[graphQLFieldName] = value;
          });
          return obj;
        });
        
        result = ${query.isList ? "data" : "data[0] || null"};
      } catch (error) {
        console.error(\`Error retrieving results for execution \${taskId}:\`, error);
        result = null;
      }
    }
    
    return {
      taskStatus,
      result,
      startDate: task.startDate,
      finishDate: finishDate
    };
  } catch (error) {
    console.error('Error getting task result:', error);
    throw error;
  }
};
`;
  }

  private generateAthenaExecutionTracker(): string {
    return `
const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { AthenaClient, GetQueryExecutionCommand } = require('@aws-sdk/client-athena');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  try {
    // EventBridge event structure for Athena Query State Change events
    // Example event structure:
    // {
    //   "detail-type": "Athena Query State Change",
    //   "source": "aws.athena",
    //   "detail": {
    //     "queryExecutionId": "01234567-0123-0123-0123-012345678901",
    //     "currentState": "SUCCEEDED",
    //     "previousState": "RUNNING",
    //     "athenaError": { ... } // Only present when FAILED
    //   }
    // }
    const executionId = event.detail?.queryExecutionId;
    const status = event.detail?.currentState;
    
    if (!executionId || !status) {
      console.log('Missing executionId or status in event:', JSON.stringify(event, null, 2));
      return { statusCode: 400, body: 'Missing required fields' };
    }
    
    // Only process terminal states (SUCCEEDED, FAILED, CANCELLED)
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status)) {
      console.log(\`Skipping non-terminal state: \${status} for execution \${executionId}\`);
      return { statusCode: 200, body: 'Skipped - non-terminal state' };
    }
    
    console.log(\`Processing Athena execution \${executionId} with status \${status}\`);
    
    // Check if task exists (executionId is the taskId)
    const taskResult = await dynamoClient.send(new GetItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: \`task#\${executionId}\` },
        SK: { S: \`task#\${executionId}\` }
      }
    }));
    
    if (!taskResult.Item) {
      console.log(\`Task entity not found for execution \${executionId} (may not be a task query)\`);
      return { statusCode: 404, body: 'Task not found' };
    }
    
    // Map Athena status to task status
    let taskStatus = 'RUNNING';
    if (status === 'SUCCEEDED') {
      taskStatus = 'SUCCEEDED';
    } else if (status === 'FAILED' || status === 'CANCELLED') {
      taskStatus = 'FAILED';
    }
    
    // Get execution details to get finish date
    let finishDate = null;
    try {
      const execResult = await athenaClient.send(new GetQueryExecutionCommand({
        QueryExecutionId: executionId
      }));
      finishDate = execResult.QueryExecution?.Status?.StateChangeDateTime || new Date().toISOString();
    } catch (error) {
      console.error(\`Error getting execution details for \${executionId}:\`, error);
      finishDate = new Date().toISOString();
    }
    
    // Reuse taskResult from earlier (already fetched at line 2301)
    const task = unmarshall(taskResult.Item);
    const taskType = task.taskType || null;
    
    // Update task entity
    const updateExpression = 'SET taskStatus = :status, finishDate = :finishDate, updatedAt = :updatedAt';
    const expressionAttributeValues = {
      ':status': { S: taskStatus },
      ':finishDate': { S: finishDate },
      ':updatedAt': { S: new Date().toISOString() }
    };
    
    await dynamoClient.send(new UpdateItemCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: { S: \`task#\${executionId}\` },
        SK: { S: \`task#\${executionId}\` }
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues
    }));
    
    console.log(\`Successfully updated task \${executionId} with status \${taskStatus}\`);
    
    // If this is a deletion task that succeeded, publish to deletion queue
    if (taskType === 'deletionTask' && taskStatus === 'SUCCEEDED') {
      const { SQSClient, SendMessageCommand } = require('@aws-sdk/client-sqs');
      const sqsClient = new SQSClient({ region: process.env.AWS_REGION });
      const DELETION_QUEUE_URL = process.env.DELETION_QUEUE_URL;
      
      if (DELETION_QUEUE_URL) {
        try {
          await sqsClient.send(new SendMessageCommand({
            QueueUrl: DELETION_QUEUE_URL,
            MessageBody: JSON.stringify({ executionId })
          }));
          console.log(\`Published deletion task \${executionId} to deletion queue\`);
        } catch (error) {
          console.error(\`Error publishing deletion task to queue:\`, error);
          // Don't fail - task is already updated
        }
      } else {
        console.warn('DELETION_QUEUE_URL not set, skipping queue publish');
      }
    }
    
    return { statusCode: 200, body: 'Success' };
  } catch (error) {
    console.error('Error tracking Athena execution:', error);
    throw error;
  }
};
`;
  }

  private generateCascadeDeletionListener(): string {
    return `
const { DynamoDBClient, QueryCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');
const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

exports.handler = async (event) => {
  try {
    console.log('Processing cascade deletion messages:', JSON.stringify(event, null, 2));
    
    for (const record of event.Records) {
      try {
        const messageBody = JSON.parse(record.body);
        const { entityType, entityId } = messageBody;
        
        console.log(\`Processing cascade deletion for \${entityType}#\${entityId}\`);
        
        // Query all joinRelation items for this entity
        // PK: joinRelation#entityType#entityId, SK starts with joinRelation#
        const pk = \`joinRelation#\${entityType}#\${entityId}\`;
        
        const queryResult = await dynamoClient.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk AND begins_with(SK, :skPrefix)',
          ExpressionAttributeValues: {
            ':pk': { S: pk },
            ':skPrefix': { S: 'joinRelation#' }
          }
        }));
        
        if (!queryResult.Items || queryResult.Items.length === 0) {
          console.log(\`No join relations found for \${entityType}#\${entityId}\`);
          continue;
        }
        
        console.log(\`Found \${queryResult.Items.length} join relations to delete\`);
        
        // Collect unique relationIds and S3 keys
        const relationIds = new Set();
        const s3KeysToDelete = new Set();
        const joinRelationItems = [];
        
        for (const item of queryResult.Items) {
          const unmarshalled = unmarshall(item);
          joinRelationItems.push(unmarshalled);
          
          if (unmarshalled.relationId) {
            relationIds.add(unmarshalled.relationId);
          }
          
          if (unmarshalled.s3Key) {
            s3KeysToDelete.add(unmarshalled.s3Key);
          }
        }
        
        // For each relationId, query GSI1 to find all related joinRelation items
        const { QueryCommand: GSI1QueryCommand } = require('@aws-sdk/client-dynamodb');
        
        for (const relationId of relationIds) {
          try {
            // Query GSI1 to get all items with this relationId
            // Use ExpressionAttributeNames for GSI1-PK since it contains a hyphen
            const gsi1Result = await dynamoClient.send(new GSI1QueryCommand({
              TableName: TABLE_NAME,
              IndexName: 'GSI1',
              KeyConditionExpression: '#gsi1Pk = :gsi1Pk',
              ExpressionAttributeNames: {
                '#gsi1Pk': 'GSI1-PK'
              },
              ExpressionAttributeValues: {
                ':gsi1Pk': { S: \`joinRelation#\${relationId}\` }
              }
            }));
            
            // Add all related items to deletion list
            if (gsi1Result.Items) {
              for (const item of gsi1Result.Items) {
                const relatedItem = unmarshall(item);
                if (!joinRelationItems.find(item => item.PK === relatedItem.PK && item.SK === relatedItem.SK)) {
                  joinRelationItems.push(relatedItem);
                  if (relatedItem.s3Key) {
                    s3KeysToDelete.add(relatedItem.s3Key);
                  }
                }
              }
            }
          } catch (error) {
            console.error(\`Error querying GSI1 for relationId \${relationId}:\`, error);
            // Continue with other relationIds
          }
        }
        
        // Bulk delete S3 objects (max 1000 per request)
        if (s3KeysToDelete.size > 0) {
          const s3KeysArray = Array.from(s3KeysToDelete).map(key => ({ Key: key }));
          const chunks = [];
          for (let i = 0; i < s3KeysArray.length; i += 1000) {
            chunks.push(s3KeysArray.slice(i, i + 1000));
          }
          
          for (const chunk of chunks) {
            try {
              await s3Client.send(new DeleteObjectsCommand({
                Bucket: BUCKET_NAME,
                Delete: {
                  Objects: chunk,
                  Quiet: false
                }
              }));
              console.log(\`Deleted \${chunk.length} S3 objects\`);
            } catch (error) {
              console.error(\`Error deleting S3 objects:\`, error);
              // Continue with other chunks
            }
          }
        }
        
        // Delete all joinRelation items from DynamoDB
        for (const item of joinRelationItems) {
          try {
            await dynamoClient.send(new DeleteItemCommand({
              TableName: TABLE_NAME,
              Key: {
                PK: { S: item.PK },
                SK: { S: item.SK }
              }
            }));
            console.log(\`Deleted joinRelation item: \${item.PK}#\${item.SK}\`);
          } catch (error) {
            console.error(\`Error deleting joinRelation item:\`, error);
            // Continue with other items
          }
        }
        
        // Delete all joinTableData items for the collected relationIds
        for (const relationId of relationIds) {
          try {
            await dynamoClient.send(new DeleteItemCommand({
              TableName: TABLE_NAME,
              Key: {
                PK: { S: \`joinTableData#\${relationId}\` },
                SK: { S: \`joinTableData#\${relationId}\` }
              }
            }));
            console.log(\`Deleted joinTableData item: joinTableData#\${relationId}\`);
          } catch (error) {
            // Item might not exist (already deleted or never created), log but continue
            console.log(\`joinTableData item joinTableData#\${relationId} not found or already deleted\`);
          }
        }
        
        console.log(\`Successfully processed cascade deletion for \${entityType}#\${entityId}\`);
      } catch (error) {
        console.error('Error processing cascade deletion message:', error);
        // Continue with other messages
      }
    }
    
    return { statusCode: 200, body: 'Cascade deletion completed' };
  } catch (error) {
    console.error('Error in cascade deletion listener:', error);
    throw error;
  }
};
`;
  }

  private generateDeletionListener(): string {
    return `
const { AthenaClient, GetQueryResultsCommand } = require('@aws-sdk/client-athena');
const { S3Client, DeleteObjectsCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, QueryCommand, DeleteItemCommand } = require('@aws-sdk/client-dynamodb');

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const s3Client = new S3Client({ region: process.env.AWS_REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const BUCKET_NAME = process.env.S3_BUCKET_NAME;
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

exports.handler = async (event) => {
  try {
    console.log('Processing deletion messages:', JSON.stringify(event, null, 2));
    
    for (const record of event.Records) {
      try {
        const messageBody = JSON.parse(record.body);
        const { executionId } = messageBody;
        
        console.log(\`Processing deletion for execution \${executionId}\`);
        
        // Get query results from Athena
        let nextToken = null;
        const deletionItems = []; // Array of { s3Key, relationId }
        
        do {
          const resultParams = {
            QueryExecutionId: executionId,
            MaxResults: 1000
          };
          
          if (nextToken) {
            resultParams.NextToken = nextToken;
          }
          
          const result = await athenaClient.send(new GetQueryResultsCommand(resultParams));
          
          // Parse results - first row is headers
          const rows = result.ResultSet?.Rows || [];
          if (rows.length > 0) {
            // Get column indices for s3Key and relationId
            const headers = rows[0].Data?.map(col => col.VarCharValue) || [];
            const s3KeyIndex = headers.findIndex(h => h && h.toLowerCase() === 's3key');
            const relationIdIndex = headers.findIndex(h => h && h.toLowerCase() === 'relationid');
            
            if (s3KeyIndex === -1) {
              throw new Error('s3Key column not found in query results');
            }
            
            if (relationIdIndex === -1) {
              throw new Error('relationId column not found in query results');
            }
            
            // Extract s3Key and relationId values from data rows
            for (let i = 1; i < rows.length; i++) {
              const row = rows[i];
              const s3KeyValue = row.Data?.[s3KeyIndex]?.VarCharValue;
              const relationIdValue = row.Data?.[relationIdIndex]?.VarCharValue;
              
              if (s3KeyValue && relationIdValue) {
                deletionItems.push({ s3Key: s3KeyValue, relationId: relationIdValue });
              }
            }
          }
          
          nextToken = result.NextToken;
        } while (nextToken);
        
        console.log(\`Found \${deletionItems.length} items to delete\`);
        
        // Process each deletion item
        for (const item of deletionItems) {
          try {
            // 1. Delete joinTableData#{relationId} item
            console.log(\`Deleting joinTableData#\${item.relationId}\`);
            await dynamoClient.send(new DeleteItemCommand({
              TableName: TABLE_NAME,
              Key: {
                PK: { S: \`joinTableData#\${item.relationId}\` },
                SK: { S: \`joinTableData#\${item.relationId}\` }
              }
            }));
            
            // 2. Query GSI1 to find all joinRelation items for this relationId
            // GSI1-PK: joinRelation#{relationId}
            const gsi1QueryResult = await dynamoClient.send(new QueryCommand({
              TableName: TABLE_NAME,
              IndexName: 'GSI1',
              KeyConditionExpression: '#gsi1Pk = :gsi1Pk',
              ExpressionAttributeNames: {
                '#gsi1Pk': 'GSI1-PK'
              },
              ExpressionAttributeValues: {
                ':gsi1Pk': { S: \`joinRelation#\${item.relationId}\` }
              }
            }));
            
            // 3. Delete all joinRelation items found
            if (gsi1QueryResult.Items && gsi1QueryResult.Items.length > 0) {
              console.log(\`Found \${gsi1QueryResult.Items.length} joinRelation items to delete for relationId \${item.relationId}\`);
              
              for (const joinRelationItem of gsi1QueryResult.Items) {
                const pk = joinRelationItem.PK?.S;
                const sk = joinRelationItem.SK?.S;
                
                if (pk && sk) {
                  await dynamoClient.send(new DeleteItemCommand({
                    TableName: TABLE_NAME,
                    Key: {
                      PK: { S: pk },
                      SK: { S: sk }
                    }
                  }));
                }
              }
            }
            
            // 4. Delete S3 Parquet file
            console.log(\`Deleting S3 object: \${item.s3Key}\`);
            await s3Client.send(new DeleteObjectsCommand({
              Bucket: BUCKET_NAME,
              Delete: {
                Objects: [{ Key: item.s3Key }],
                Quiet: false
              }
            }));
            
            console.log(\`Successfully deleted item with relationId \${item.relationId}\`);
          } catch (error) {
            console.error(\`Error deleting item with relationId \${item.relationId}:\`, error);
            // Continue with other items
          }
        }
        
        console.log(\`Successfully processed deletion for execution \${executionId}\`);
      } catch (error) {
        console.error('Error processing deletion message:', error);
        // Continue with other messages
      }
    }
    
    return { statusCode: 200, body: 'Deletion processing completed' };
  } catch (error) {
    console.error('Error in deletion listener:', error);
    throw error;
  }
};
`;
  }
}
