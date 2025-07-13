#!/usr/bin/env node

import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { deployGraphQLService } from "./commands/deploy";
import { destroyGraphQLService } from "./commands/destroy";
import { validateSchema } from "./utils/schema-validator";
import { loadSchema } from "./utils/schema-loader";

const program = new Command();

program
  .name("oc-graphql")
  .description(
    "One Command GraphQL - Serverless GraphQL automation tool for AWS"
  )
  .version("1.0.0");

program
  .command("deploy")
  .description("Deploy GraphQL service to AWS")
  .requiredOption("-n, --name <name>", "Project name")
  .requiredOption("-f, --file <file>", "GraphQL schema file path")
  .option("-r, --region <region>", "AWS region", "us-east-1")
  .option("--profile <profile>", "AWS profile to use")
  .action(async (options) => {
    const spinner = ora("Starting deployment...").start();

    try {
      // Validate inputs
      if (!options.name) {
        throw new Error("Project name is required");
      }

      if (!options.file) {
        throw new Error("Schema file is required");
      }

      spinner.text = "Loading and validating schema...";
      const schema = await loadSchema(options.file);
      await validateSchema(schema);

      spinner.text = "Deploying GraphQL service...";
      await deployGraphQLService({
        projectName: options.name,
        schemaFile: options.file,
        region: options.region,
        profile: options.profile,
        schema,
      });

      spinner.succeed(chalk.green("✅ GraphQL service deployed successfully!"));

      console.log(chalk.blue("\n🚀 Your GraphQL API is ready:"));
      console.log(
        chalk.cyan(
          `   • AppSync URL: https://${options.region}.amazonaws.com/graphql`
        )
      );
      console.log(chalk.cyan(`   • DynamoDB Table: ${options.name}`));
      console.log(chalk.cyan(`   • S3 Bucket: ${options.name}-{account-id}`));
      console.log(chalk.cyan(`   • Athena Database: ${options.name}_db`));
    } catch (error) {
      spinner.fail(chalk.red("❌ Deployment failed"));
      console.error(
        chalk.red(error instanceof Error ? error.message : "Unknown error")
      );
      process.exit(1);
    }
  });

program
  .command("validate")
  .description("Validate GraphQL schema")
  .requiredOption("-f, --file <file>", "GraphQL schema file path")
  .action(async (options) => {
    const spinner = ora("Validating schema...").start();

    try {
      const schema = await loadSchema(options.file);
      await validateSchema(schema);
      spinner.succeed(chalk.green("✅ Schema is valid!"));
    } catch (error) {
      spinner.fail(chalk.red("❌ Schema validation failed"));
      console.error(
        chalk.red(error instanceof Error ? error.message : "Unknown error")
      );
      process.exit(1);
    }
  });

program
  .command("destroy")
  .description("Destroy GraphQL service from AWS")
  .requiredOption("-n, --name <name>", "Project name")
  .option("-r, --region <region>", "AWS region", "us-east-1")
  .option("--profile <profile>", "AWS profile to use")
  .option(
    "--retain-storage",
    "Retain storage services (S3, DynamoDB) - recommended",
    true
  )
  .option(
    "--delete-all",
    "Delete ALL resources including data - DANGEROUS!",
    false
  )
  .action(async (options) => {
    const spinner = ora("Preparing to destroy GraphQL service...").start();

    try {
      // Validate inputs
      if (!options.name) {
        throw new Error("Project name is required");
      }

      spinner.stop();

      // Show warning and require confirmation
      console.log(chalk.red("\n⚠️  DESTRUCTIVE OPERATION WARNING ⚠️"));
      console.log(
        chalk.yellow(
          `You are about to destroy the GraphQL service: ${chalk.bold(options.name)}`
        )
      );

      if (options.deleteAll) {
        console.log(chalk.red("🚨 ALL DATA WILL BE PERMANENTLY DELETED! 🚨"));
      } else {
        console.log(
          chalk.blue("📦 Storage services will be retained for data safety.")
        );
      }

      // In a real CLI, you'd use inquirer for interactive confirmation
      // For now, we'll proceed with a warning
      console.log(
        chalk.yellow("\n⏳ Proceeding with destroy operation in 3 seconds...")
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));

      spinner.start("Destroying GraphQL service...");

      await destroyGraphQLService({
        projectName: options.name,
        region: options.region,
        profile: options.profile,
        retainStorage: !options.deleteAll,
      });

      spinner.succeed(
        chalk.green("✅ GraphQL service destroyed successfully!")
      );
    } catch (error) {
      spinner.fail(chalk.red("❌ Destroy operation failed"));
      console.error(
        chalk.red(error instanceof Error ? error.message : "Unknown error")
      );
      process.exit(1);
    }
  });

program.parse();
