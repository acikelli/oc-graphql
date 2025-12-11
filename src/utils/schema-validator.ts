import {
  buildSchema,
  GraphQLError,
  validateSchema as graphqlValidateSchema,
} from "graphql";

/**
 * Pre-processes schema to add missing return types for mutations
 * INSERT mutations -> Boolean!
 * DELETE mutations -> handled separately (will be removed from schema)
 */
function preprocessSchema(schemaString: string): string {
  // Find Mutation type block - match everything between { and }
  const mutationTypePattern = /(type\s+Mutation\s*{)([\s\S]*?)(^})/m;
  const mutationMatch = schemaString.match(mutationTypePattern);

  if (!mutationMatch) {
    return schemaString; // No Mutation type found
  }

  const mutationFields = mutationMatch[2];
  const lines = mutationFields.split("\n");
  const processedLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Check if this line is a field definition without return type
    // Pattern: fieldName(args) followed by optional whitespace (no colon before @sql_query)
    const fieldDefMatch = trimmedLine.match(/^(\w+)\s*\(([^)]*)\)\s*$/);

    if (fieldDefMatch) {
      const fieldName = fieldDefMatch[1];
      const args = fieldDefMatch[2];

      // Look ahead to find @sql_query directive (may be on next lines)
      let sqlQuery = "";
      let foundDirective = false;
      for (let j = i + 1; j < lines.length && j < i + 10; j++) {
        const nextLine = lines[j];
        // Match @sql_query with query parameter - handle both single and multi-line
        const sqlQueryMatch =
          nextLine.match(/@sql_query\s*\(\s*query:\s*"([^"]+)"/) ||
          nextLine.match(/query:\s*"([^"]+)"/);
        if (sqlQueryMatch) {
          sqlQuery = sqlQueryMatch[1].trim().toUpperCase();
          foundDirective = true;
          break;
        }
        // Stop if we hit another field definition
        if (nextLine.trim().match(/^\w+\s*\(/)) {
          break;
        }
      }

      if (foundDirective && sqlQuery) {
        let returnType: string;
        if (sqlQuery.startsWith("DELETE")) {
          // DELETE mutations will be removed from schema, but we need to add a placeholder
          // to make GraphQL parser happy. We'll use Boolean! as placeholder.
          returnType = "Boolean!";
        } else if (sqlQuery.startsWith("INSERT")) {
          returnType = "Boolean!";
        } else {
          // Keep original line if we can't auto-infer
          processedLines.push(line);
          continue;
        }

        // Replace the line with field definition including return type
        const indent = line.match(/^(\s*)/)?.[1] || "";
        processedLines.push(`${indent}${fieldName}(${args}): ${returnType}`);
        continue;
      }
    }

    processedLines.push(line);
  }

  // Reconstruct the Mutation type
  const processedFields = processedLines.join("\n");
  return schemaString.replace(mutationTypePattern, `$1${processedFields}$3`);
}

export async function validateSchema(schemaString: string): Promise<void> {
  try {
    // Pre-process schema to add missing return types
    const preprocessedSchema = preprocessSchema(schemaString);

    // Add custom directive definitions to make schema valid for GraphQL validation
    const directiveDefinitions = `
      directive @sql_query(query: String!) on FIELD_DEFINITION
      directive @return(value: String!) on FIELD_DEFINITION
      directive @task_response on OBJECT
    `;

    const schemaWithDirectives =
      directiveDefinitions + "\n" + preprocessedSchema;

    // Basic GraphQL syntax validation
    const schema = buildSchema(schemaWithDirectives);

    // Validate schema structure
    const errors = graphqlValidateSchema(schema);
    if (errors.length > 0) {
      const errorMessages = errors.map((error) => error.message).join("\n");
      throw new Error(`GraphQL schema validation failed:\n${errorMessages}`);
    }

    // Validate custom directives
    validateCustomDirectives(schemaString);

    // Validate DELETE queries use $join_table()
    validateDeleteQueries(schemaString);

    // Validate type structure
    validateTypeStructure(schemaString);
  } catch (error) {
    if (error instanceof GraphQLError) {
      throw new Error(`Schema syntax error: ${error.message}`);
    }
    throw error;
  }
}

function validateCustomDirectives(schemaString: string): void {
  const validDirectives = [
    "@sql_query",
    "@return",
    "@task_response",
    "@skip",
    "@include",
    "@deprecated",
  ];

  // Check for invalid directive usage
  const directiveMatches = schemaString.match(/@\w+/g) || [];
  const invalidDirectives = directiveMatches.filter(
    (directive) => !validDirectives.some((valid) => directive.startsWith(valid))
  );

  if (invalidDirectives.length > 0) {
    throw new Error(
      `Invalid custom directives found: ${invalidDirectives.join(", ")}`
    );
  }

  // Validate @sql_query directive structure - simplified validation
  const sqlQueryMatches = schemaString.match(/@sql_query[^)]*\)/gs) || [];

  for (const match of sqlQueryMatches) {
    if (!match.includes("query:")) {
      throw new Error(
        `@sql_query directive must include a query parameter: ${match.substring(0, 50)}...`
      );
    }
  }

  // Validate join table references
  const joinTablePattern = /\$join_table\([^)]+\)/g;
  const joinTableMatches = schemaString.match(joinTablePattern) || [];

  for (const match of joinTableMatches) {
    const tableName = match.match(/\$join_table\(([^)]+)\)/)?.[1];
    if (!tableName || tableName.trim().length === 0) {
      throw new Error(`Invalid join table reference: ${match}`);
    }
  }
}

function validateDeleteQueries(schemaString: string): void {
  // Extract Mutation type
  const mutationTypePattern = /type\s+Mutation\s*{([\s\S]*?)}/;
  const mutationMatch = schemaString.match(mutationTypePattern);

  if (!mutationMatch) {
    return; // No Mutation type found
  }

  const mutationFields = mutationMatch[1];

  // Find all @sql_query directives in Mutation fields
  const sqlQueryPattern = /@sql_query\s*\(\s*query:\s*"([^"]+)"/g;
  let match: RegExpMatchArray | null;

  // Find the field name for each DELETE query
  const fieldPattern = /(\w+)\s*\([^)]*\)/g;
  const fields: Array<{ name: string; query: string }> = [];
  let fieldMatch: RegExpMatchArray | null;
  let currentFieldName = "";

  // Extract field names and their queries
  const lines = mutationFields.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fieldNameMatch = line.match(/^\s*(\w+)\s*\(/);
    if (fieldNameMatch) {
      currentFieldName = fieldNameMatch[1];
    }

    const queryMatch = line.match(/query:\s*"([^"]+)"/);
    if (queryMatch && currentFieldName) {
      const query = queryMatch[1].trim();
      if (query.toUpperCase().startsWith("DELETE")) {
        fields.push({ name: currentFieldName, query });
      }
    }
  }

  // Validate each DELETE query uses $join_table()
  for (const field of fields) {
    if (!field.query.includes("$join_table(")) {
      throw new Error(
        `DELETE query in mutation '${field.name}' must use $join_table() wrapper for table names. ` +
          `Example: DELETE alias FROM $join_table(table_name) alias ...`
      );
    }

    // Validate the format: DELETE [alias] FROM $join_table(table_name) [alias] ...
    const deletePattern = /DELETE\s+(?:\w+\s+)?FROM\s+\$join_table\s*\(/i;
    if (!deletePattern.test(field.query)) {
      throw new Error(
        `Invalid DELETE query format in mutation '${field.name}'. ` +
          `Must use: DELETE [alias] FROM $join_table(table_name) [alias] ...`
      );
    }
  }
}

function validateTypeStructure(schemaString: string): void {
  // Check for required root types
  if (!schemaString.includes("type Query")) {
    throw new Error("Schema must include a Query type");
  }

  // Validate that @sql_query is only used on Query and Mutation fields, not on type fields
  const typePattern = /type\s+(\w+)\s*{([^}]*)}/g;
  let match;

  while ((match = typePattern.exec(schemaString)) !== null) {
    const typeName = match[1];
    const fields = match[2];

    // Skip Query and Mutation types - they can have @sql_query
    if (typeName === "Query" || typeName === "Mutation") {
      continue;
    }

    // Check if any field in this type has @sql_query directive
    if (fields.includes("@sql_query")) {
      throw new Error(
        `@sql_query directive can only be used on Query and Mutation fields, not on type '${typeName}' fields`
      );
    }
  }

  // Validate that @resolver directive is not used (deprecated)
  if (schemaString.includes("@resolver")) {
    throw new Error(
      "@resolver directive is no longer supported. Use @sql_query on Query/Mutation fields instead."
    );
  }

  // Validate field types are properly defined
  const fieldPattern = /(\w+):\s*(\[?\w+[!?]*\]?[!?]*)/g;
  const definedTypes = extractDefinedTypes(schemaString);
  const builtInTypes = [
    "String",
    "Int",
    "Float",
    "Boolean",
    "ID",
    "AWSDateTime",
  ];

  while ((match = fieldPattern.exec(schemaString)) !== null) {
    const fieldType = match[2].replace(/[\[\]!]/g, "");

    if (
      !builtInTypes.includes(fieldType) &&
      !definedTypes.includes(fieldType)
    ) {
      // Type not found - this could be a custom type that needs to be defined
      // For now, we'll skip this warning to avoid console dependency
    }
  }

  // Validate Query fields require @task_response on return types
  validateQueryTaskResponse(schemaString);
}

function validateQueryTaskResponse(schemaString: string): void {
  // Extract all Query fields (all Query fields are automatically tasks)
  const queryTypePattern = /type\s+Query\s*{([\s\S]*?)}/;
  const queryMatch = schemaString.match(queryTypePattern);

  if (!queryMatch) {
    return; // No Query type found
  }

  const queryFields = queryMatch[1];

  // Find all Query field definitions
  // Pattern: fieldName(args): ReturnType
  // The return type can be: Type, Type!, [Type!]!, etc.
  const fieldDefPattern =
    /(\w+)\s*\([^)]*\)\s*:\s*(\[?)(\w+)([!?]*)(\]?)([!?]*)/g;
  let match: RegExpMatchArray | null;

  while ((match = fieldDefPattern.exec(queryFields)) !== null) {
    const fieldName = match[1];
    const returnType = match[3]; // Extract the type name (e.g., "User" from "[User!]!")

    // Skip built-in types
    const builtInTypes = [
      "String",
      "Int",
      "Float",
      "Boolean",
      "ID",
      "AWSDateTime",
    ];
    if (!builtInTypes.includes(returnType)) {
      validateTaskResponseType(schemaString, fieldName, returnType);
    }
  }
}

function validateTaskResponseType(
  schemaString: string,
  fieldName: string,
  returnType: string
): void {
  // Check if return type has @task_response directive
  // Match: type User @task_response { ... } or type User @task_response{ ... }
  const typePattern = new RegExp(
    `type\\s+${returnType}\\s+@task_response[^{]*{`,
    "s"
  );
  if (!typePattern.test(schemaString)) {
    throw new Error(
      `Query field "${fieldName}" requires its return type "${returnType}" to have @task_response directive`
    );
  }
}

function extractDefinedTypes(schemaString: string): string[] {
  const typePattern = /(?:type|enum|interface|union)\s+(\w+)/g;
  const types: string[] = [];
  let match;

  while ((match = typePattern.exec(schemaString)) !== null) {
    types.push(match[1]);
  }

  return types;
}

export function validateProjectName(projectName: string): void {
  // AWS resource naming constraints
  const validNamePattern = /^[a-zA-Z][a-zA-Z0-9-]*$/;

  if (!validNamePattern.test(projectName)) {
    throw new Error(
      "Project name must start with a letter and contain only letters, numbers, and hyphens"
    );
  }

  if (projectName.length < 3 || projectName.length > 63) {
    throw new Error("Project name must be between 3 and 63 characters long");
  }

  if (projectName.endsWith("-")) {
    throw new Error("Project name cannot end with a hyphen");
  }

  if (projectName.includes("--")) {
    throw new Error("Project name cannot contain consecutive hyphens");
  }
}

export function validateRegion(region: string): void {
  const validRegions = [
    "us-east-1",
    "us-east-2",
    "us-west-1",
    "us-west-2",
    "eu-west-1",
    "eu-west-2",
    "eu-west-3",
    "eu-central-1",
    "ap-southeast-1",
    "ap-southeast-2",
    "ap-northeast-1",
    "ap-northeast-2",
    "ap-south-1",
    "ca-central-1",
    "sa-east-1",
  ];

  if (!validRegions.includes(region)) {
    throw new Error(
      `Invalid AWS region: ${region}. Supported regions: ${validRegions.join(", ")}`
    );
  }
}
