## ADDED Requirements

### Requirement: associative_recall routing rule
The router config SHALL include an `associative_recall` rule routing queries with signals like "reminds me of", "related to", "connected" to `experimental` class with fallback to `knowledge_graph`.

#### Scenario: Associative query routes to BrainX
- **WHEN** a query contains "what reminds me of" or "related to"
- **THEN** the router dispatches to the `experimental` class

## MODIFIED Requirements

### Requirement: Router dispatch supports degraded backends
The `router.sh` `build_dispatch_chain` SHALL include `degraded` backends in the available set, ordered after `ready` backends.

#### Scenario: degraded backend used as fallback
- **WHEN** no `ready` backend in a class returns results above threshold
- **THEN** the router falls back to `degraded` backends in the same class before moving to the fallback class

### Requirement: No tier restrictions on backend access
All routing rules SHALL dispatch to backends without tier-based restrictions.

#### Scenario: All classes accessible
- **WHEN** any routing rule matches a query
- **THEN** the rule dispatches to the configured primary_class without checking tier or license
