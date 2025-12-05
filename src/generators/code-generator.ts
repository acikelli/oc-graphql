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
      if (!type.isPrimitive && !type.isResolver && !type.isTaskResponse) {
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

    // Generate resolver functions for @sql_query directives
    for (const query of this.schemaMetadata.queries) {
      if (query.sqlQuery) {
        lambdaFunctions[`ocg-${this.projectName}-query-${query.name}.js`] =
          this.generateSqlQueryFunction(query);
      }
    }

    for (const mutation of this.schemaMetadata.mutations) {
      if (mutation.sqlQuery) {
        lambdaFunctions[
          `ocg-${this.projectName}-mutation-${mutation.name}.js`
        ] = this.generateSqlQueryFunction(mutation);
      }
    }

    // Generate resolver functions for types with @resolver directive
    for (const type of this.schemaMetadata.types) {
      if (type.isResolver) {
        lambdaFunctions[
          `ocg-${this.projectName}-resolver-${type.name.toLowerCase()}.js`
        ] = this.generateResolverFunction(type);
      }
    }

    // Generate individual field resolvers for fields with @sql_query in regular types
    for (const type of this.schemaMetadata.types) {
      if (!type.isPrimitive && !type.isResolver) {
        for (const field of type.fields) {
          if (field.sqlQuery) {
            lambdaFunctions[
              `ocg-${this.projectName}-field-${type.name.toLowerCase()}-${field.name}.js`
            ] = this.generateSqlQueryFunction(field);
          }
        }
      }
    }

    // Generate DynamoDB stream processor (Python with Parquet support)
    lambdaFunctions[`ocg-${this.projectName}-stream-processor.py`] =
      this.generateStreamProcessor();

    // Generate cascade deletion queue listener Lambda
    lambdaFunctions[`ocg-${this.projectName}-cascade-deletion-listener.js`] =
      this.generateCascadeDeletionListener();

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
const { DynamoDBClient, PutItemCommand } = require('@aws-sdk/client-dynamodb');
const { marshall } = require('@aws-sdk/util-dynamodb');
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
        const relationId = uuidv4();
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
        
        // Build the join table item
        const item = {
          entityType: tableName,
          joinTable: tableName,
          createdAt: now
        };
        
        // Add all arguments as fields
        argEntries.forEach(([key, value]) => {
          item[key] = value;
        });
        
        // Build PK/SK from first two entity mappings
        const pkFields = [];
        const skFields = [];
        
        if (entityMappings.length >= 2) {
          pkFields.push(\`\${entityMappings[0].entityType.toLowerCase()}#\${entityMappings[0].value}\`);
          skFields.push(\`\${entityMappings[1].entityType.toLowerCase()}#\${entityMappings[1].value}\`);
        } else if (entityMappings.length === 1) {
          pkFields.push(\`\${entityMappings[0].entityType.toLowerCase()}#\${entityMappings[0].value}\`);
        }
        
        // Construct PK and SK for the join table item
        item.PK = \`relation#\${tableName}#\${pkFields.join('#')}\`;
        item.SK = \`relation#\${tableName}#\${skFields.join('#')}\`;
        
        // Calculate S3 key (will be written by stream processor)
        // The stream processor extracts key components by splitting PK/SK by '#' and taking parts[2:]
        // For PK: relation#tableName#entityType#id -> ['relation', 'tableName', 'entityType', 'id'] -> [2:] = ['entityType', 'id']
        // For SK: relation#tableName#entityType#id -> ['relation', 'tableName', 'entityType', 'id'] -> [2:] = ['entityType', 'id']
        // Then joins all with '_': entityType_id_entityType_id
        const currentDate = new Date();
        const year = currentDate.getUTCFullYear();
        const month = String(currentDate.getUTCMonth() + 1).padStart(2, '0');
        const day = String(currentDate.getUTCDate()).padStart(2, '0');
        // Extract just the values (entityType and id) from pkFields and skFields, matching stream processor logic
        const keyComponents = [];
        pkFields.forEach(field => {
          const parts = field.split('#');
          if (parts.length >= 2) {
            keyComponents.push(parts[0]); // entityType
            keyComponents.push(parts[1]); // id
          }
        });
        skFields.forEach(field => {
          const parts = field.split('#');
          if (parts.length >= 2) {
            keyComponents.push(parts[0]); // entityType
            keyComponents.push(parts[1]); // id
          }
        });
        const keyString = keyComponents.join('_');
        const s3Key = \`tables/\${tableName}/year=\${year}/month=\${month}/day=\${day}/\${keyString}.parquet\`;
        
        console.log(\`Creating join table item for \${tableName}:\`, item);
        
        // Save the join table item
        await dynamoClient.send(new PutItemCommand({
          TableName: TABLE_NAME,
          Item: marshall(item)
        }));
        
        // Save joinRelation items for each entity type to enable cascade deletion
        // Use lowercase entity type to match DynamoDB entityType field
        for (const mapping of entityMappings) {
          const entityTypeLower = mapping.entityType.toLowerCase();
          const joinRelationItem = {
            PK: \`joinRelation#\${entityTypeLower}#\${mapping.value}\`,
            SK: \`joinRelation#\${relationId}#\${entityTypeLower}#\${mapping.value}\`,
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
        
        return item;
      }
    }
`;
  }

  private generateResolverFunction(type: TypeMetadata): string {
    const fieldsWithQueries = type.fields.filter((f) => f.sqlQuery);

    return `
const { AthenaClient, StartQueryExecutionCommand, GetQueryExecutionCommand, GetQueryResultsCommand } = require('@aws-sdk/client-athena');

const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const DATABASE_NAME = process.env.ATHENA_DATABASE_NAME;
const S3_OUTPUT_LOCATION = process.env.ATHENA_OUTPUT_LOCATION;

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
    const sourceArgs = event.source || {};
    const fieldArgs = event.arguments || {};
    
    console.log('Resolver function called with:', { sourceArgs, fieldArgs });
    
    // Determine which field is being requested from the GraphQL info
    const requestedField = event.info?.fieldName;
    console.log('Requested field:', requestedField);
    if (event.source.calculatedResponse) {
      console.log('Returning from calculatedResponse:', requestedField);
      return event.source.calculatedResponse[requestedField];
    }
    // Run all SQL queries in parallel
    const queryPromises = [
${fieldsWithQueries
  .map((field) => {
    // For list fields, return the entire result array
    // For scalar fields, extract the value from the first row
    // If the result has a field matching the field name, use that
    // Otherwise, try _col0 or the first value in the object
    const fieldType = this.schemaMetadata.types.find(
      (t) => t.name === field.type
    );
    const isScalar = fieldType?.isPrimitive || false;

    if (field.isList) {
      return `
      executeQuery(\`${field.sqlQuery!.query}\`, { ...sourceArgs, ...fieldArgs })
        .then(result => ({ field: '${field.name}', result: result }))
`;
    } else {
      // For scalar fields, extract the value from the first row
      // Try field name first, then _col0, then first value in object
      return `
      executeQuery(\`${field.sqlQuery!.query}\`, { ...sourceArgs, ...fieldArgs })
        .then(result => {
          if (!result || result.length === 0) return { field: '${field.name}', result: null };
          const firstRow = result[0];
          let value = null;
          
          // Try to get value by field name (e.g., result[0].total for "total" field)
          if (firstRow['${field.name}'] !== undefined) {
            value = firstRow['${field.name}'];
          } else if (firstRow['_col0'] !== undefined) {
            // Fallback to _col0 (for queries like SELECT COUNT(*) without alias)
            value = firstRow['_col0'];
          } else {
            // Fallback to first value in the object
            const keys = Object.keys(firstRow);
            if (keys.length > 0) {
              value = firstRow[keys[0]];
            }
          }
          
          // Convert to appropriate type
          ${
            field.type === "Int"
              ? `
          if (value !== null && value !== undefined) {
            const num = typeof value === 'string' ? parseInt(value, 10) : Number(value);
            value = isNaN(num) ? null : num;
          }`
              : ""
          }
          ${
            field.type === "Float"
              ? `
          if (value !== null && value !== undefined) {
            const num = typeof value === 'string' ? parseFloat(value) : Number(value);
            value = isNaN(num) ? null : num;
          }`
              : ""
          }
          ${
            field.type === "Boolean"
              ? `
          if (value !== null && value !== undefined) {
            if (typeof value === 'string') {
              value = value.toLowerCase() === 'true' || value === '1';
            } else {
              value = Boolean(value);
            }
          }`
              : ""
          }
          
          return { field: '${field.name}', result: value };
        })
`;
    }
  })
  .join(",\n")}
    ];
    
    const results = await Promise.all(queryPromises);
    
    // Build response object
    const response = {};
    results.forEach(({ field, result }) => {
      response[field] = result;
    });
    
    // Handle @return directives - extract actual values from args or source
    ${type.fields
      .filter((f) => f.returnValue)
      .map((f) => {
        const returnValue = f.returnValue!.value;
        if (returnValue.startsWith("$args.")) {
          const argKey = returnValue.replace("$args.", "");
          return `response.${f.name} = fieldArgs.${argKey};`;
        } else if (returnValue.startsWith("$source.")) {
          const sourceKey = returnValue.replace("$source.", "");
          return `response.${f.name} = sourceArgs.${sourceKey};`;
        } else {
          // Static value
          return `response.${f.name} = ${returnValue};`;
        }
      })
      .join("\n    ")}
    
    console.log('Resolver response:', response);
    
    // Return only the requested field value, not the entire response object
    if (requestedField && response.hasOwnProperty(requestedField)) {
      console.log(\`Returning field '\${requestedField}':\`, response[requestedField]);
      return response[requestedField];
    }
    
    // Fallback: return entire response if field not found
    console.log('Field not found, returning entire response');
    return { calculatedResponse: response, event };
  } catch (error) {
    console.error('Error in resolver:', error);
    throw error;
  }
};

async function executeQuery(query, args) {
  try {
    console.log('Executing query with args:', { query, args });
    
    // Replace parameter placeholders with SQL-safe escaping
    Object.entries(args).forEach(([key, value]) => {
      const argsPattern = '$args.' + key;
      const sourcePattern = '$source.' + key;
      const sqlSafeValue = escapeSqlValue(value);
      query = query.split(argsPattern).join(sqlSafeValue);
      query = query.split(sourcePattern).join(sqlSafeValue);
    });
    
    console.log('Query after parameter replacement:', query);
    
    // Replace join table references
    query = query.replace(/\$join_table\(([^)]+)\)/g, '$1');
    
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
      console.log("Query execution result:", JSON.stringify(result, null, 2));
      status = result.QueryExecution?.Status?.State || 'FAILED';
    }
    
    if (status !== 'SUCCEEDED') {
      throw new Error(\`Query failed with status: \${status}\`);
    }
    
    // Get query results
    const results = await athenaClient.send(new GetQueryResultsCommand({
      QueryExecutionId: queryExecutionId
    }));
    
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
    
    console.log('Query results:', data);
    return data;
  } catch (error) {
    console.error('Error executing query:', error);
    throw error;
  }
}
`;
  }

  private generateStreamProcessor(): string {
    const fs = require("fs");
    const path = require("path");

    try {
      // Read the Python stream processor file
      const pythonFilePath = path.join(__dirname, "python-stream-processor.py");
      return fs.readFileSync(pythonFilePath, "utf8");
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
glue_client = boto3.client('glue')
sqs_client = boto3.client('sqs')

BUCKET_NAME = os.environ['S3_BUCKET_NAME']
GLUE_DATABASE = os.environ['ATHENA_DATABASE_NAME']
CASCADE_DELETION_QUEUE_URL = os.environ.get('CASCADE_DELETION_QUEUE_URL')

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
    
    # Determine S3 key for deletion with date partitioning
    if item.get('joinTable'):
        # Join table deletion - just delete the S3 file
        join_table = item['joinTable']
        pk_parts = item['PK'].split('#')
        sk_parts = item['SK'].split('#')
        key_components = pk_parts[2:] + sk_parts[2:]
        key_string = '_'.join(key_components)
        
        # Use original creation date for deletion if available
        item_date = parse_item_date(item.get('createdAt'), current_date)
        item_year, item_month, item_day = format_date_parts(item_date)
        
        s3_key = f"tables/{join_table}/year={item_year}/month={item_month}/day={item_day}/{key_string}.parquet"
        
        logger.info(f"Deleting join table S3 object: {s3_key}")
        
        # Delete from S3
        try:
            s3_client.delete_object(Bucket=BUCKET_NAME, Key=s3_key)
            logger.info(f"Successfully deleted join table S3 object: {s3_key}")
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
    
    # Add processing metadata
    item['_processing_timestamp'] = current_date.isoformat()
    item['_event_name'] = event_name
    item['_partition_year'] = year
    item['_partition_month'] = month
    item['_partition_day'] = day
    
    if item.get('joinTable'):
        handle_join_table_item(item, year, month, day, event_name)
    else:
        handle_regular_entity_item(item, entity_type, year, month, day, event_name)

def handle_join_table_item(item, year, month, day, event_name):
    """Handle join table items with date partitioning"""
    join_table = item['joinTable']
    pk_parts = item['PK'].split('#')
    sk_parts = item['SK'].split('#')
    
    key_components = pk_parts[2:] + sk_parts[2:]
    key_string = '_'.join(key_components)
    
    s3_key = f"tables/{join_table}/year={year}/month={month}/day={day}/{key_string}.parquet"
    table_location = f"s3://{BUCKET_NAME}/tables/{join_table}/"
    athena_table_name = join_table
    
    logger.info(f"Processing join table item for '{join_table}' - {event_name}")
    
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
    """Convert DynamoDB item to pandas DataFrame with proper timestamp handling"""
    # Create DataFrame with single row, minimal metadata
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
                # Keep as string if conversion fails
                df[column] = df[column].astype('string')
        
        # Optimize numeric types without pandas overhead
        elif df[column].dtype == 'object':
            # Try to convert to most efficient numeric type
            try:
                numeric_series = pd.to_numeric(df[column], errors='ignore')
                if not numeric_series.equals(df[column]):
                    # Check if it's integer
                    if numeric_series.dtype == 'int64':
                        df[column] = numeric_series.astype('int32')  # Use smaller int type
                    elif numeric_series.dtype == 'float64':
                        df[column] = numeric_series.astype('float32')  # Use smaller float type
                    else:
                        df[column] = numeric_series
                else:
                    # Keep as minimal string type
                    df[column] = df[column].astype('string')
            except:
                df[column] = df[column].astype('string')
        
        # Convert other types to minimal representations
        elif df[column].dtype == 'bool':
            df[column] = df[column].astype('bool')  # Already minimal
        elif df[column].dtype == 'int64':
            df[column] = df[column].astype('int32')  # Use smaller int
        elif df[column].dtype == 'float64':
            df[column] = df[column].astype('float32')  # Use smaller float
    
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

def ensure_optimized_glue_table(table_name, location, sample_item, df):
    """Create or update Glue table with Parquet format support"""
    try:
        # Check if table exists
        glue_client.get_table(DatabaseName=GLUE_DATABASE, Name=table_name)
        logger.info(f"Table '{table_name}' already exists")
        return
    except glue_client.exceptions.EntityNotFoundException:
        logger.info(f"Creating new Parquet table: {table_name}")
        create_parquet_glue_table(table_name, location, sample_item, df)

def create_parquet_glue_table(table_name, location, sample_item, df):
    """Create optimized Parquet Glue table using processed DataFrame types"""
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
        logger.info(f"Creating Parquet column: {column_name} -> {column_type}")
    
    # Add partition columns
    partition_keys = [
        {'Name': 'year', 'Type': 'string'},
        {'Name': 'month', 'Type': 'string'},
        {'Name': 'day', 'Type': 'string'}
    ]
    
    # Build storage template using string operations to avoid template literal conflicts
    template_path = location + 'year={year}/month={month}/day={day}/'
    storage_template = template_path.replace('{year}', '$' + '{year}').replace('{month}', '$' + '{month}').replace('{day}', '$' + '{day}')
    
    logger.info(f"Creating optimized Parquet table '{table_name}' with {len(columns)} columns")
    
    # Create Parquet table
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
      if (!type.isPrimitive && !type.isResolver) {
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
    let fields: string;

    if (type.isResolver) {
      // For resolver types, include all fields since they're resolved by Lambda functions
      fields = type.fields
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
    } else {
      // For regular types, include scalar fields AND fields with SQL queries AND fields that return resolver types
      fields = type.fields
        .filter((field) => {
          // Include if it's a scalar type
          if (this.isScalarType(field.type)) return true;

          // Include if it has a SQL query
          if (field.sqlQuery) return true;

          // Include if it returns a resolver type
          const referencedType = this.schemaMetadata.types.find(
            (t) => t.name === field.type
          );
          if (referencedType && referencedType.isResolver) return true;

          return false;
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
    }

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
      .filter((type) => !type.isPrimitive && !type.isResolver)
      .map((type) => `  read${type.name}(id: ID!): ${type.name}`)
      .join("\n");

    const crudMutations = this.schemaMetadata.types
      .filter((type) => !type.isPrimitive && !type.isResolver)
      .flatMap((type) => [
        `  create${type.name}(input: Create${type.name}Input!): ${type.name}!`,
        `  update${type.name}(id: ID!, input: Update${type.name}Input!): ${type.name}!`,
        `  delete${type.name}(id: ID!): DeleteResult!`,
      ])
      .join("\n");

    // Generate custom queries with their arguments
    const customQueries = this.schemaMetadata.queries
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
        const returnType = q.isList ? `[${q.type}!]` : q.type;
        const required = q.isRequired ? "!" : "";
        return `  ${q.name}${argsString}: ${returnType}${required}`;
      })
      .join("\n");

    // Generate custom mutations with their arguments
    const customMutations = this.schemaMetadata.mutations
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
        const returnType = m.isList ? `[${m.type}!]` : m.type;
        const required = m.isRequired ? "!" : "";
        return `  ${m.name}${argsString}: ${returnType}${required}`;
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

    return `
type Query {
${crudQueries}
${customQueries}
${taskResultQueries}
}

type Mutation {
${crudMutations}
${customMutations}
${taskMutations}
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

  private countSqlQueriesInQuery(query: FieldMetadata): number {
    // For simple queries with @sql_query, count is 1
    if (query.sqlQuery) {
      return 1;
    }

    // If query returns a resolver type, count SQL queries in that type
    const resolverType = this.schemaMetadata.types.find(
      (t) => t.name === query.type && t.isResolver
    );

    if (resolverType) {
      // Count all fields with @sql_query in the resolver type
      return resolverType.fields.filter((f) => f.sqlQuery).length;
    }

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

    return `
const { DynamoDBClient, GetItemCommand, UpdateItemCommand } = require('@aws-sdk/client-dynamodb');
const { AthenaClient, GetQueryExecutionCommand, GetQueryResultsCommand } = require('@aws-sdk/client-athena');
const { unmarshall } = require('@aws-sdk/util-dynamodb');

const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION });
const athenaClient = new AthenaClient({ region: process.env.AWS_REGION });
const TABLE_NAME = process.env.DYNAMODB_TABLE_NAME;

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
            obj[headers[index]] = col.VarCharValue;
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
        const pk = \`joinRelation#\${entityType}#\${entityId}\`;
        
        const queryResult = await dynamoClient.send(new QueryCommand({
          TableName: TABLE_NAME,
          KeyConditionExpression: 'PK = :pk',
          ExpressionAttributeValues: {
            ':pk': { S: pk }
          }
        }));
        
        if (!queryResult.Items || queryResult.Items.length === 0) {
          console.log(\`No join relations found for \${entityType}#\${entityId}\`);
          continue;
        }
        
        console.log(\`Found \${queryResult.Items.length} join relations to delete\`);
        
        // Group S3 keys by bucket (for bulk delete)
        const s3KeysToDelete = [];
        const joinRelationItems = [];
        
        for (const item of queryResult.Items) {
          const unmarshalled = unmarshall(item);
          joinRelationItems.push(unmarshalled);
          
          if (unmarshalled.s3Key) {
            s3KeysToDelete.push({ Key: unmarshalled.s3Key });
          }
        }
        
        // Bulk delete S3 objects (max 1000 per request)
        if (s3KeysToDelete.length > 0) {
          const chunks = [];
          for (let i = 0; i < s3KeysToDelete.length; i += 1000) {
            chunks.push(s3KeysToDelete.slice(i, i + 1000));
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
        
        // Delete joinRelation items from DynamoDB
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
}
