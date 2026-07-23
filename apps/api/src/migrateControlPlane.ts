import { runControlPlaneMigrationCli } from './migrations/controlPlaneMigrationCli'

process.exitCode = await runControlPlaneMigrationCli(process.env)
