// Transitional shared contracts package.
//
// The source of truth remains in src/contracts during the modular-monolith phase.
// External consumers should import from @insightflow/contracts so the package can
// later own the schema files without forcing app-wide import churn.
export * from '../../../src/contracts'
