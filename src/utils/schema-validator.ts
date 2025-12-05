import {
  buildSchema,
  GraphQLError,
  validateSchema as graphqlValidateSchema,
} from "graphql";

export async function validateSchema(schemaString: string): Promise<void> {
  try {
    // Add custom directive definitions to make schema valid for GraphQL validation
    const directiveDefinitions = `
      directive @sql_query(query: String!) on FIELD_DEFINITION
      directive @resolver on OBJECT
      directive @return(value: String!) on FIELD_DEFINITION
      directive @task on FIELD_DEFINITION
      directive @task_response on OBJECT
    `;

    const schemaWithDirectives = directiveDefinitions + "\n" + schemaString;

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
    "@resolver",
    "@return",
    "@task",
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

  // Validate virtual table references
  const virtualTablePattern = /\$virtual_table\([^)]+\)/g;
  const virtualTableMatches = schemaString.match(virtualTablePattern) || [];

  for (const match of virtualTableMatches) {
    const tableName = match.match(/\$virtual_table\(([^)]+)\)/)?.[1];
    if (!tableName || tableName.trim().length === 0) {
      throw new Error(`Invalid virtual table reference: ${match}`);
    }
  }
}

function validateTypeStructure(schemaString: string): void {
  // Check for required root types
  if (!schemaString.includes("type Query")) {
    throw new Error("Schema must include a Query type");
  }

  // Validate that types with @resolver directive have appropriate fields
  const resolverTypePattern = /type\s+(\w+)[^{]*@resolver[^{]*{([^}]*)}/g;
  let match;

  while ((match = resolverTypePattern.exec(schemaString)) !== null) {
    const typeName = match[1];
    const fields = match[2];

    // Check if resolver type has at least one field with @sql_query
    if (!fields.includes("@sql_query")) {
      throw new Error(
        `Resolver type ${typeName} must have at least one field with @sql_query directive`
      );
    }
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

  // Validate @task directive usage
  validateTaskDirective(schemaString);
}

function validateTaskDirective(schemaString: string): void {
  // Extract all Query fields with @task directive
  const queryTypePattern = /type\s+Query\s*{([\s\S]*?)}/;
  const queryMatch = schemaString.match(queryTypePattern);
  
  if (!queryMatch) {
    return; // No Query type found
  }

  const queryFields = queryMatch[1];
  
  // Find all fields that have @task directive
  // Pattern: fieldName(args): ReturnType ... @task ...
  // We need to match the field definition and extract the return type
  // The return type can be: Type, Type!, [Type!]!, etc.
  
  // Find all occurrences of @task in Query fields
  const taskMatches = [...queryFields.matchAll(/@task/g)];
  
  for (const taskMatch of taskMatches) {
    const taskIndex = taskMatch.index!;
    
    // Look backwards from @task to find the field definition
    const beforeTask = queryFields.substring(0, taskIndex);
    
    // Find the field definition - look for pattern: fieldName(args): ReturnType
    // We need to find the last field definition before @task
    const fieldDefPattern = /(\w+)\s*\([^)]*\)\s*:\s*(\[?)(\w+)([!?]*)(\]?)([!?]*)/g;
    let lastMatch: RegExpMatchArray | null = null;
    let match: RegExpMatchArray | null;
    
    // Find all field definitions before @task
    while ((match = fieldDefPattern.exec(beforeTask)) !== null) {
      lastMatch = match;
    }
    
    if (lastMatch) {
      const fieldName = lastMatch[1];
      const returnType = lastMatch[3]; // Extract the type name (e.g., "User" from "[User!]!")
      
      // Skip built-in types
      const builtInTypes = ['String', 'Int', 'Float', 'Boolean', 'ID', 'AWSDateTime'];
      if (!builtInTypes.includes(returnType)) {
        validateTaskResponseType(schemaString, fieldName, returnType);
      }
    }
  }

  // Check that @task is only used on Query fields (not Mutation)
  const mutationTypePattern = /type\s+Mutation\s*{([\s\S]*?)}/;
  const mutationMatch = schemaString.match(mutationTypePattern);
  
  if (mutationMatch) {
    const mutationFields = mutationMatch[1];
    if (mutationFields.includes('@task')) {
      throw new Error('@task directive can only be used on Query fields, not Mutation fields');
    }
  }
}

function validateTaskResponseType(schemaString: string, fieldName: string, returnType: string): void {
  // Check if return type has @task_response directive
  // Match: type User @task_response { ... } or type User @task_response{ ... }
  const typePattern = new RegExp(`type\\s+${returnType}\\s+@task_response[^{]*{`, 's');
  if (!typePattern.test(schemaString)) {
    throw new Error(
      `@task directive on Query field "${fieldName}" requires its return type "${returnType}" to have @task_response directive`
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
