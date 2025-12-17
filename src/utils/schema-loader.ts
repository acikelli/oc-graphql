import * as fs from 'fs-extra';
import * as path from 'path';

export async function loadSchema(schemaPath: string): Promise<string> {
  try {
    // Resolve the absolute path
    const absolutePath = path.resolve(schemaPath);
    
    // Check if file exists
    const exists = await fs.pathExists(absolutePath);
    if (!exists) {
      throw new Error(`Schema file not found: ${schemaPath}`);
    }
    
    // Check if it's a file (not a directory)
    const stats = await fs.stat(absolutePath);
    if (!stats.isFile()) {
      throw new Error(`Path is not a file: ${schemaPath}`);
    }
    
    // Read the schema file
    const schema = await fs.readFile(absolutePath, 'utf-8');
    
    if (!schema.trim()) {
      throw new Error(`Schema file is empty: ${schemaPath}`);
    }
    
    return schema;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to load schema: ${error.message}`);
    }
    throw new Error(`Failed to load schema: Unknown error`);
  }
}

export function validateSchemaFile(schemaPath: string): void {
  // Check file extension
  const extension = path.extname(schemaPath).toLowerCase();
  const validExtensions = ['.graphql', '.gql'];
  
  if (!validExtensions.includes(extension)) {
    throw new Error(`Invalid schema file extension: ${extension}. Expected: ${validExtensions.join(', ')}`);
  }
}

export async function writeSchema(schemaContent: string, outputPath: string): Promise<void> {
  try {
    // Ensure directory exists
    const directory = path.dirname(outputPath);
    await fs.ensureDir(directory);
    
    // Write schema file
    await fs.writeFile(outputPath, schemaContent, 'utf-8');
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to write schema: ${error.message}`);
    }
    throw new Error(`Failed to write schema: Unknown error`);
  }
} 