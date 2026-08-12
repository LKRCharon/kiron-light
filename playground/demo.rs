#![allow(dead_code)]

//! Kiron Fleet Control Plane
//!
//! A standard-library-only domain model for multi-tenant release orchestration.
//! The file intentionally includes a large, deterministic fixture catalog so the
//! Kiron Light playground exercises realistic Rust syntax at production scale.

use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct TenantId(String);

impl TenantId {
    fn parse(value: impl Into<String>) -> Result<Self, FleetError> {
        let value = value.into();
        validate_slug("tenant", &value)?;
        Ok(Self(value))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for TenantId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct ServiceId(String);

impl ServiceId {
    fn parse(value: impl Into<String>) -> Result<Self, FleetError> {
        let value = value.into();
        validate_slug("service", &value)?;
        Ok(Self(value))
    }

    fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for ServiceId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
struct ReleaseId(String);

impl ReleaseId {
    fn from_spec(spec: &ReleaseSpec) -> Self {
        Self(format!(
            "rel-{}-{}-{}-{}",
            spec.tenant,
            spec.service,
            spec.version.compact(),
            spec.sequence
        ))
    }
}

impl fmt::Display for ReleaseId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

fn validate_slug(kind: &'static str, value: &str) -> Result<(), FleetError> {
    let valid_length = (3..=63).contains(&value.len());
    let valid_edges = !value.starts_with('-') && !value.ends_with('-');
    let valid_chars = value
        .bytes()
        .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-');

    if valid_length && valid_edges && valid_chars {
        Ok(())
    } else {
        Err(FleetError::InvalidIdentifier {
            kind,
            value: value.to_owned(),
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct SemanticVersion {
    major: u16,
    minor: u16,
    patch: u16,
    pre_release: Option<String>,
}

impl SemanticVersion {
    fn parse(input: &str) -> Result<Self, FleetError> {
        let (base, pre_release) = match input.split_once('-') {
            Some((base, suffix)) if !suffix.is_empty() => (base, Some(suffix.to_owned())),
            Some(_) => return Err(FleetError::InvalidVersion(input.to_owned())),
            None => (input, None),
        };
        let components: Vec<&str> = base.split('.').collect();
        if components.len() != 3 {
            return Err(FleetError::InvalidVersion(input.to_owned()));
        }
        let parse_component = |component: &str| {
            component
                .parse::<u16>()
                .map_err(|_| FleetError::InvalidVersion(input.to_owned()))
        };
        Ok(Self {
            major: parse_component(components[0])?,
            minor: parse_component(components[1])?,
            patch: parse_component(components[2])?,
            pre_release,
        })
    }

    fn compact(&self) -> String {
        format!("{}-{}-{}", self.major, self.minor, self.patch)
    }
}

impl fmt::Display for SemanticVersion {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}.{}.{}", self.major, self.minor, self.patch)?;
        if let Some(suffix) = &self.pre_release {
            write!(formatter, "-{suffix}")?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Environment {
    Development,
    Staging,
    Production,
}

impl Environment {
    fn is_production(self) -> bool {
        matches!(self, Self::Production)
    }
}

impl fmt::Display for Environment {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Development => "development",
            Self::Staging => "staging",
            Self::Production => "production",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Region {
    UsEast1,
    UsWest2,
    EuWest1,
    ApSoutheast1,
    ApNortheast1,
}

impl Region {
    fn code(self) -> &'static str {
        match self {
            Self::UsEast1 => "us-east-1",
            Self::UsWest2 => "us-west-2",
            Self::EuWest1 => "eu-west-1",
            Self::ApSoutheast1 => "ap-southeast-1",
            Self::ApNortheast1 => "ap-northeast-1",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RiskTier {
    Low,
    Medium,
    High,
    Critical,
}

impl RiskTier {
    fn minimum_approvals(self) -> usize {
        match self {
            Self::Low => 1,
            Self::Medium => 1,
            Self::High => 2,
            Self::Critical => 3,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FixtureStrategy {
    Canary,
    Linear,
    BlueGreen,
    FeatureFlag,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum RolloutStrategy {
    Canary {
        initial_percent: u8,
        steps: Vec<u8>,
        soak_seconds: u64,
    },
    Linear {
        step_percent: u8,
        soak_seconds: u64,
    },
    BlueGreen {
        preview_seconds: u64,
    },
    FeatureFlag {
        flag_key: String,
        steps: Vec<u8>,
        soak_seconds: u64,
    },
}

impl FixtureStrategy {
    fn materialize(self, tenant: &TenantId, service: &ServiceId) -> RolloutStrategy {
        match self {
            Self::Canary => RolloutStrategy::Canary {
                initial_percent: 1,
                steps: vec![5, 10, 25, 50, 100],
                soak_seconds: 300,
            },
            Self::Linear => RolloutStrategy::Linear {
                step_percent: 20,
                soak_seconds: 420,
            },
            Self::BlueGreen => RolloutStrategy::BlueGreen {
                preview_seconds: 600,
            },
            Self::FeatureFlag => RolloutStrategy::FeatureFlag {
                flag_key: format!("{}.{}.release", tenant, service),
                steps: vec![0, 1, 10, 25, 50, 100],
                soak_seconds: 240,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReleasePhase {
    Draft,
    Validated,
    Approved,
    Queued,
    Deploying,
    Observing,
    Completed,
    RollingBack,
    RolledBack,
    Failed,
}

impl ReleasePhase {
    fn permits(self, next: Self) -> bool {
        use ReleasePhase::*;
        matches!(
            (self, next),
            (Draft, Validated)
                | (Validated, Approved)
                | (Approved, Queued)
                | (Queued, Deploying)
                | (Deploying, Observing)
                | (Observing, Completed)
                | (Deploying, RollingBack)
                | (Observing, RollingBack)
                | (Completed, RollingBack)
                | (RollingBack, RolledBack)
                | (Draft, Failed)
                | (Validated, Failed)
                | (Approved, Failed)
                | (Queued, Failed)
                | (Deploying, Failed)
                | (Observing, Failed)
        )
    }

    fn is_terminal(self) -> bool {
        matches!(self, Self::Completed | Self::RolledBack | Self::Failed)
    }
}

#[derive(Debug, Clone)]
struct DeploymentTarget {
    environment: Environment,
    region: Region,
    cluster: String,
    desired_replicas: u16,
}

#[derive(Debug, Clone)]
struct Artifact {
    image_digest: String,
    provenance_attestation: String,
    sbom_uri: String,
    rollback_digest: Option<String>,
}

impl Artifact {
    fn validate(&self) -> Result<(), FleetError> {
        if !self.image_digest.starts_with("sha256:") || self.image_digest.len() < 20 {
            return Err(FleetError::InvalidArtifact("image digest".to_owned()));
        }
        if self.provenance_attestation.is_empty() {
            return Err(FleetError::InvalidArtifact(
                "missing provenance attestation".to_owned(),
            ));
        }
        if !self.sbom_uri.starts_with("https://") {
            return Err(FleetError::InvalidArtifact("SBOM URI".to_owned()));
        }
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct ReleaseSpec {
    tenant: TenantId,
    service: ServiceId,
    version: SemanticVersion,
    sequence: u32,
    risk: RiskTier,
    strategy: RolloutStrategy,
    targets: Vec<DeploymentTarget>,
    artifact: Artifact,
    change_ticket: String,
}

impl ReleaseSpec {
    fn validate(&self) -> Result<(), FleetError> {
        self.artifact.validate()?;
        if self.targets.is_empty() {
            return Err(FleetError::EmptyTargets);
        }
        if self.change_ticket.trim().is_empty() {
            return Err(FleetError::MissingChangeTicket);
        }
        let mut unique = BTreeSet::new();
        for target in &self.targets {
            if target.desired_replicas == 0 {
                return Err(FleetError::InvalidReplicaCount(target.cluster.clone()));
            }
            let key = (target.environment, target.region, target.cluster.as_str());
            if !unique.insert(key) {
                return Err(FleetError::DuplicateTarget(target.cluster.clone()));
            }
        }
        Ok(())
    }

    fn includes_production(&self) -> bool {
        self.targets
            .iter()
            .any(|target| target.environment.is_production())
    }
}

#[derive(Debug, Clone)]
struct ReleaseRecord {
    id: ReleaseId,
    spec: ReleaseSpec,
    phase: ReleasePhase,
    revision: u64,
    reason: Option<String>,
}

impl ReleaseRecord {
    fn new(spec: ReleaseSpec) -> Self {
        Self {
            id: ReleaseId::from_spec(&spec),
            spec,
            phase: ReleasePhase::Draft,
            revision: 1,
            reason: None,
        }
    }

    fn transition(
        &mut self,
        next: ReleasePhase,
        expected_revision: u64,
        reason: impl Into<String>,
    ) -> Result<(), FleetError> {
        if self.revision != expected_revision {
            return Err(FleetError::RevisionConflict {
                expected: expected_revision,
                actual: self.revision,
            });
        }
        if !self.phase.permits(next) {
            return Err(FleetError::InvalidTransition {
                from: self.phase,
                to: next,
            });
        }
        self.phase = next;
        self.revision += 1;
        self.reason = Some(reason.into());
        Ok(())
    }
}

#[derive(Debug, Clone)]
struct FlagContext {
    tenant: TenantId,
    region: Region,
    environment: Environment,
    account_tags: BTreeSet<String>,
    stable_bucket: u16,
}

#[derive(Debug, Clone)]
enum FlagPredicate {
    Tenant(TenantId),
    Region(Region),
    Environment(Environment),
    AccountTag(String),
    Percentage(u16),
}

impl FlagPredicate {
    fn matches(&self, context: &FlagContext) -> bool {
        match self {
            Self::Tenant(tenant) => tenant == &context.tenant,
            Self::Region(region) => region == &context.region,
            Self::Environment(environment) => environment == &context.environment,
            Self::AccountTag(tag) => context.account_tags.contains(tag),
            Self::Percentage(basis_points) => context.stable_bucket < *basis_points,
        }
    }
}

#[derive(Debug, Clone)]
struct FlagRule {
    description: String,
    all: Vec<FlagPredicate>,
    enabled: bool,
}

#[derive(Debug, Clone)]
struct FeatureFlag {
    key: String,
    owner: String,
    default_enabled: bool,
    rules: Vec<FlagRule>,
}

impl FeatureFlag {
    fn evaluate(&self, context: &FlagContext) -> bool {
        self.rules
            .iter()
            .find(|rule| rule.all.iter().all(|predicate| predicate.matches(context)))
            .map(|rule| rule.enabled)
            .unwrap_or(self.default_enabled)
    }
}

#[derive(Debug, Clone)]
struct SloDefinition {
    name: String,
    target_basis_points: u16,
    window_minutes: u32,
    minimum_requests: u64,
}

#[derive(Debug, Clone)]
struct SloSample {
    total_requests: u64,
    successful_requests: u64,
    p95_latency_ms: u32,
    error_budget_remaining_bps: u16,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SloState {
    Healthy,
    AtRisk,
    Breached,
    InsufficientData,
}

impl SloDefinition {
    fn evaluate(&self, sample: &SloSample) -> SloState {
        if sample.total_requests < self.minimum_requests {
            return SloState::InsufficientData;
        }
        let availability = sample
            .successful_requests
            .saturating_mul(10_000)
            .checked_div(sample.total_requests)
            .unwrap_or_default();
        if availability < u64::from(self.target_basis_points)
            || sample.error_budget_remaining_bps < 500
        {
            SloState::Breached
        } else if sample.error_budget_remaining_bps < 2_000 {
            SloState::AtRisk
        } else {
            SloState::Healthy
        }
    }
}

#[derive(Debug, Clone)]
struct AlertRule {
    id: String,
    severity: AlertSeverity,
    expression: String,
    for_seconds: u64,
    runbook: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AlertSeverity {
    Info,
    Warning,
    Critical,
}

#[derive(Debug, Clone)]
struct PolicyContext {
    actor: String,
    approvals: BTreeSet<String>,
    maintenance_window_open: bool,
    error_budget_remaining_bps: u16,
    freeze_active: bool,
    emergency_override_ticket: Option<String>,
}

#[derive(Debug, Clone)]
struct PolicyDecision {
    allowed: bool,
    reasons: Vec<String>,
    required_approvals: usize,
}

struct PolicyEngine {
    production_error_budget_floor_bps: u16,
    allowed_actor_prefixes: Vec<String>,
}

impl PolicyEngine {
    fn production_default() -> Self {
        Self {
            production_error_budget_floor_bps: 2_500,
            allowed_actor_prefixes: vec!["user:".to_owned(), "service:release-bot".to_owned()],
        }
    }

    fn evaluate(&self, spec: &ReleaseSpec, context: &PolicyContext) -> PolicyDecision {
        let mut reasons = Vec::new();
        if !self
            .allowed_actor_prefixes
            .iter()
            .any(|prefix| context.actor.starts_with(prefix))
        {
            reasons.push("actor is not permitted to submit releases".to_owned());
        }
        let required_approvals = spec.risk.minimum_approvals();
        if context.approvals.len() < required_approvals {
            reasons.push(format!(
                "{} approval(s) required, {} supplied",
                required_approvals,
                context.approvals.len()
            ));
        }
        if spec.includes_production() {
            if !context.maintenance_window_open {
                reasons.push("production maintenance window is closed".to_owned());
            }
            if context.error_budget_remaining_bps < self.production_error_budget_floor_bps {
                reasons.push("production error budget is below release floor".to_owned());
            }
            if spec.artifact.rollback_digest.is_none() {
                reasons.push("production release lacks a rollback artifact".to_owned());
            }
        }
        if context.freeze_active && context.emergency_override_ticket.is_none() {
            reasons.push("release freeze is active without an emergency override".to_owned());
        }
        PolicyDecision {
            allowed: reasons.is_empty(),
            reasons,
            required_approvals,
        }
    }
}

#[derive(Debug, Clone)]
struct RolloutStage {
    name: String,
    traffic_percent: u8,
    soak: Duration,
    maximum_error_rate_bps: u16,
    requires_manual_approval: bool,
}

#[derive(Debug, Clone)]
struct ReleasePlan {
    release_id: ReleaseId,
    stages: Vec<RolloutStage>,
    targets: Vec<DeploymentTarget>,
}

struct RolloutPlanner;

impl RolloutPlanner {
    fn build(spec: &ReleaseSpec) -> Result<ReleasePlan, FleetError> {
        spec.validate()?;
        let stages = match &spec.strategy {
            RolloutStrategy::Canary {
                initial_percent,
                steps,
                soak_seconds,
            } => {
                let mut percentages = vec![*initial_percent];
                percentages.extend(steps.iter().copied());
                normalize_percentages(percentages)?
                    .into_iter()
                    .enumerate()
                    .map(|(index, percentage)| RolloutStage {
                        name: format!("canary-{:02}-{}pct", index + 1, percentage),
                        traffic_percent: percentage,
                        soak: Duration::from_secs(*soak_seconds),
                        maximum_error_rate_bps: if percentage <= 10 { 75 } else { 50 },
                        requires_manual_approval: percentage >= 50,
                    })
                    .collect()
            }
            RolloutStrategy::Linear {
                step_percent,
                soak_seconds,
            } => {
                if *step_percent == 0 || *step_percent > 100 {
                    return Err(FleetError::InvalidStrategy(
                        "linear step must be in 1..=100".to_owned(),
                    ));
                }
                let mut stages = Vec::new();
                let mut percentage = *step_percent;
                loop {
                    let bounded = percentage.min(100);
                    stages.push(RolloutStage {
                        name: format!("linear-{}pct", bounded),
                        traffic_percent: bounded,
                        soak: Duration::from_secs(*soak_seconds),
                        maximum_error_rate_bps: 60,
                        requires_manual_approval: bounded == 100,
                    });
                    if bounded == 100 {
                        break;
                    }
                    percentage = percentage.saturating_add(*step_percent);
                }
                stages
            }
            RolloutStrategy::BlueGreen { preview_seconds } => vec![
                RolloutStage {
                    name: "green-preview".to_owned(),
                    traffic_percent: 0,
                    soak: Duration::from_secs(*preview_seconds),
                    maximum_error_rate_bps: 40,
                    requires_manual_approval: true,
                },
                RolloutStage {
                    name: "traffic-switch".to_owned(),
                    traffic_percent: 100,
                    soak: Duration::from_secs(600),
                    maximum_error_rate_bps: 40,
                    requires_manual_approval: true,
                },
            ],
            RolloutStrategy::FeatureFlag {
                flag_key,
                steps,
                soak_seconds,
            } => {
                if flag_key.trim().is_empty() {
                    return Err(FleetError::InvalidStrategy(
                        "feature flag key cannot be empty".to_owned(),
                    ));
                }
                normalize_percentages(steps.clone())?
                    .into_iter()
                    .map(|percentage| RolloutStage {
                        name: format!("flag-{}-{}pct", flag_key, percentage),
                        traffic_percent: percentage,
                        soak: Duration::from_secs(*soak_seconds),
                        maximum_error_rate_bps: 50,
                        requires_manual_approval: percentage >= 50,
                    })
                    .collect()
            }
        };
        Ok(ReleasePlan {
            release_id: ReleaseId::from_spec(spec),
            stages,
            targets: spec.targets.clone(),
        })
    }
}

fn normalize_percentages(values: Vec<u8>) -> Result<Vec<u8>, FleetError> {
    if values.is_empty() {
        return Err(FleetError::InvalidStrategy(
            "rollout has no traffic stages".to_owned(),
        ));
    }
    let mut output = Vec::new();
    for value in values {
        if value > 100 {
            return Err(FleetError::InvalidStrategy(format!(
                "traffic percentage {value} exceeds 100"
            )));
        }
        if output.last().copied() != Some(value) {
            output.push(value);
        }
    }
    if output.last().copied() != Some(100) {
        output.push(100);
    }
    Ok(output)
}

#[derive(Debug, Clone)]
struct AuditEvent {
    sequence: u64,
    timestamp_unix_ms: u64,
    tenant: TenantId,
    actor: String,
    action: String,
    resource: String,
    decision: String,
    previous_checksum: u64,
    checksum: u64,
}

impl AuditEvent {
    fn new(
        sequence: u64,
        timestamp_unix_ms: u64,
        tenant: TenantId,
        actor: impl Into<String>,
        action: impl Into<String>,
        resource: impl Into<String>,
        decision: impl Into<String>,
        previous_checksum: u64,
    ) -> Self {
        let actor = actor.into();
        let action = action.into();
        let resource = resource.into();
        let decision = decision.into();
        let checksum = audit_checksum(&[
            &sequence.to_string(),
            &timestamp_unix_ms.to_string(),
            tenant.as_str(),
            &actor,
            &action,
            &resource,
            &decision,
            &previous_checksum.to_string(),
        ]);
        Self {
            sequence,
            timestamp_unix_ms,
            tenant,
            actor,
            action,
            resource,
            decision,
            previous_checksum,
            checksum,
        }
    }
}

fn audit_checksum(parts: &[&str]) -> u64 {
    let mut hash = 0xcbf29ce484222325_u64;
    for part in parts {
        for byte in part.as_bytes().iter().chain(std::iter::once(&0xff)) {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
    }
    hash
}

trait FleetStore {
    fn insert_release(&mut self, release: ReleaseRecord) -> Result<(), FleetError>;
    fn release(&self, id: &ReleaseId) -> Result<&ReleaseRecord, FleetError>;
    fn release_mut(&mut self, id: &ReleaseId) -> Result<&mut ReleaseRecord, FleetError>;
    fn append_audit(&mut self, event: AuditEvent) -> Result<(), FleetError>;
    fn audits(&self) -> &[AuditEvent];
}

#[derive(Default)]
struct InMemoryStore {
    releases: BTreeMap<ReleaseId, ReleaseRecord>,
    audits: Vec<AuditEvent>,
    flags: BTreeMap<String, FeatureFlag>,
}

impl FleetStore for InMemoryStore {
    fn insert_release(&mut self, release: ReleaseRecord) -> Result<(), FleetError> {
        if self.releases.contains_key(&release.id) {
            return Err(FleetError::DuplicateRelease(release.id));
        }
        self.releases.insert(release.id.clone(), release);
        Ok(())
    }

    fn release(&self, id: &ReleaseId) -> Result<&ReleaseRecord, FleetError> {
        self.releases
            .get(id)
            .ok_or_else(|| FleetError::ReleaseNotFound(id.clone()))
    }

    fn release_mut(&mut self, id: &ReleaseId) -> Result<&mut ReleaseRecord, FleetError> {
        self.releases
            .get_mut(id)
            .ok_or_else(|| FleetError::ReleaseNotFound(id.clone()))
    }

    fn append_audit(&mut self, event: AuditEvent) -> Result<(), FleetError> {
        let expected_sequence = self.audits.len() as u64 + 1;
        let expected_previous = self
            .audits
            .last()
            .map(|previous| previous.checksum)
            .unwrap_or_default();
        if event.sequence != expected_sequence || event.previous_checksum != expected_previous {
            return Err(FleetError::InvalidAuditChain);
        }
        self.audits.push(event);
        Ok(())
    }

    fn audits(&self) -> &[AuditEvent] {
        &self.audits
    }
}

struct FleetController<S: FleetStore> {
    store: S,
    policies: PolicyEngine,
    logical_clock_ms: u64,
}

impl<S: FleetStore> FleetController<S> {
    fn new(store: S, policies: PolicyEngine) -> Self {
        Self {
            store,
            policies,
            logical_clock_ms: 1_700_000_000_000,
        }
    }

    fn submit(
        &mut self,
        spec: ReleaseSpec,
        context: &PolicyContext,
    ) -> Result<ReleasePlan, FleetError> {
        spec.validate()?;
        let decision = self.policies.evaluate(&spec, context);
        self.write_audit(
            spec.tenant.clone(),
            context.actor.clone(),
            "release.submit",
            format!("{}/{}@{}", spec.tenant, spec.service, spec.version),
            if decision.allowed { "allow" } else { "deny" },
        )?;
        if !decision.allowed {
            return Err(FleetError::PolicyDenied(decision.reasons));
        }
        let plan = RolloutPlanner::build(&spec)?;
        let record = ReleaseRecord::new(spec);
        self.store.insert_release(record)?;
        self.transition(
            &plan.release_id,
            ReleasePhase::Validated,
            context.actor.as_str(),
            "artifact and release specification validated",
        )?;
        self.transition(
            &plan.release_id,
            ReleasePhase::Approved,
            context.actor.as_str(),
            "required approvals and policy checks satisfied",
        )?;
        Ok(plan)
    }

    fn transition(
        &mut self,
        release_id: &ReleaseId,
        next: ReleasePhase,
        actor: &str,
        reason: &str,
    ) -> Result<(), FleetError> {
        let (tenant, revision) = {
            let record = self.store.release(release_id)?;
            (record.spec.tenant.clone(), record.revision)
        };
        self.store
            .release_mut(release_id)?
            .transition(next, revision, reason)?;
        self.write_audit(
            tenant,
            actor.to_owned(),
            "release.transition",
            release_id.to_string(),
            format!("{next:?}"),
        )
    }

    fn rollback(
        &mut self,
        release_id: &ReleaseId,
        actor: &str,
        reason: &str,
    ) -> Result<(), FleetError> {
        let phase = self.store.release(release_id)?.phase;
        if !matches!(
            phase,
            ReleasePhase::Deploying | ReleasePhase::Observing | ReleasePhase::Completed
        ) {
            return Err(FleetError::RollbackUnavailable(phase));
        }
        self.transition(
            release_id,
            ReleasePhase::RollingBack,
            actor,
            reason,
        )?;
        self.transition(
            release_id,
            ReleasePhase::RolledBack,
            actor,
            "rollback artifact restored and health checks passed",
        )
    }

    fn write_audit(
        &mut self,
        tenant: TenantId,
        actor: String,
        action: &str,
        resource: String,
        decision: impl Into<String>,
    ) -> Result<(), FleetError> {
        self.logical_clock_ms += 1_000;
        let sequence = self.store.audits().len() as u64 + 1;
        let previous_checksum = self
            .store
            .audits()
            .last()
            .map(|event| event.checksum)
            .unwrap_or_default();
        let event = AuditEvent::new(
            sequence,
            self.logical_clock_ms,
            tenant,
            actor,
            action,
            resource,
            decision,
            previous_checksum,
        );
        self.store.append_audit(event)
    }
}

#[derive(Debug, Clone)]
enum FleetError {
    InvalidIdentifier {
        kind: &'static str,
        value: String,
    },
    InvalidVersion(String),
    InvalidArtifact(String),
    EmptyTargets,
    MissingChangeTicket,
    InvalidReplicaCount(String),
    DuplicateTarget(String),
    InvalidStrategy(String),
    InvalidTransition {
        from: ReleasePhase,
        to: ReleasePhase,
    },
    RevisionConflict {
        expected: u64,
        actual: u64,
    },
    PolicyDenied(Vec<String>),
    DuplicateRelease(ReleaseId),
    ReleaseNotFound(ReleaseId),
    RollbackUnavailable(ReleasePhase),
    InvalidAuditChain,
}

impl fmt::Display for FleetError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidIdentifier { kind, value } => {
                write!(formatter, "invalid {kind} identifier: {value}")
            }
            Self::InvalidVersion(value) => write!(formatter, "invalid semantic version: {value}"),
            Self::InvalidArtifact(reason) => write!(formatter, "invalid artifact: {reason}"),
            Self::EmptyTargets => formatter.write_str("release has no deployment targets"),
            Self::MissingChangeTicket => formatter.write_str("release lacks a change ticket"),
            Self::InvalidReplicaCount(cluster) => {
                write!(formatter, "target {cluster} has zero replicas")
            }
            Self::DuplicateTarget(cluster) => write!(formatter, "duplicate target: {cluster}"),
            Self::InvalidStrategy(reason) => write!(formatter, "invalid rollout strategy: {reason}"),
            Self::InvalidTransition { from, to } => {
                write!(formatter, "invalid release transition: {from:?} -> {to:?}")
            }
            Self::RevisionConflict { expected, actual } => {
                write!(formatter, "revision conflict: expected {expected}, actual {actual}")
            }
            Self::PolicyDenied(reasons) => {
                write!(formatter, "release denied: {}", reasons.join("; "))
            }
            Self::DuplicateRelease(id) => write!(formatter, "release already exists: {id}"),
            Self::ReleaseNotFound(id) => write!(formatter, "release not found: {id}"),
            Self::RollbackUnavailable(phase) => {
                write!(formatter, "rollback unavailable from phase {phase:?}")
            }
            Self::InvalidAuditChain => formatter.write_str("invalid audit event chain"),
        }
    }
}

impl Error for FleetError {}

#[derive(Debug, Clone, Copy)]
struct FixtureSeed {
    tenant: &'static str,
    service: &'static str,
    version: &'static str,
    environment: Environment,
    region: Region,
    risk: RiskTier,
    strategy: FixtureStrategy,
    desired_replicas: u16,
    error_budget_remaining_bps: u16,
    approval_count: usize,
}

fn fixture_seeds() -> &'static [FixtureSeed] {
    &[
    FixtureSeed {
        tenant: "northwind-retail",
        service: "checkout-api",
        version: "2.10.0",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 3,
        error_budget_remaining_bps: 5200,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "northwind-retail",
        service: "catalog-api",
        version: "3.13.7",
        environment: Environment::Staging,
        region: Region::UsWest2,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 4,
        error_budget_remaining_bps: 5337,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "northwind-retail",
        service: "pricing-worker",
        version: "4.16.14",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 5,
        error_budget_remaining_bps: 5474,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "northwind-retail",
        service: "storefront-web",
        version: "5.19.2",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 6,
        error_budget_remaining_bps: 5611,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "atlas-banking",
        service: "ledger-api",
        version: "2.22.9",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 7,
        error_budget_remaining_bps: 5748,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "atlas-banking",
        service: "payments-gateway",
        version: "3.25.16",
        environment: Environment::Staging,
        region: Region::UsEast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 8,
        error_budget_remaining_bps: 5885,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "atlas-banking",
        service: "fraud-scorer",
        version: "4.28.4",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 9,
        error_budget_remaining_bps: 6022,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "atlas-banking",
        service: "customer-portal",
        version: "5.31.11",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 10,
        error_budget_remaining_bps: 6159,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "helios-health",
        service: "patient-api",
        version: "2.34.18",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 11,
        error_budget_remaining_bps: 6296,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "helios-health",
        service: "claims-worker",
        version: "3.37.6",
        environment: Environment::Staging,
        region: Region::ApNortheast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 12,
        error_budget_remaining_bps: 6433,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "helios-health",
        service: "scheduling-api",
        version: "4.10.13",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 13,
        error_budget_remaining_bps: 6570,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "helios-health",
        service: "care-console",
        version: "5.13.1",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 14,
        error_budget_remaining_bps: 6707,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "orion-logistics",
        service: "routing-engine",
        version: "2.16.8",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 15,
        error_budget_remaining_bps: 6844,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "orion-logistics",
        service: "shipment-api",
        version: "3.19.15",
        environment: Environment::Staging,
        region: Region::ApSoutheast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 16,
        error_budget_remaining_bps: 6981,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "orion-logistics",
        service: "tracking-stream",
        version: "4.22.3",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 17,
        error_budget_remaining_bps: 7118,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "orion-logistics",
        service: "ops-dashboard",
        version: "5.25.10",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 18,
        error_budget_remaining_bps: 7255,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "cedar-media",
        service: "content-api",
        version: "2.28.17",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 19,
        error_budget_remaining_bps: 7392,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "cedar-media",
        service: "recommendation-worker",
        version: "3.31.5",
        environment: Environment::Staging,
        region: Region::EuWest1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 20,
        error_budget_remaining_bps: 7529,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "cedar-media",
        service: "transcode-orchestrator",
        version: "4.34.12",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 21,
        error_budget_remaining_bps: 7666,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "cedar-media",
        service: "studio-web",
        version: "5.37.0",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 22,
        error_budget_remaining_bps: 7803,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "aurora-energy",
        service: "meter-ingest",
        version: "2.10.7",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 23,
        error_budget_remaining_bps: 7940,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "aurora-energy",
        service: "billing-api",
        version: "3.13.14",
        environment: Environment::Staging,
        region: Region::UsWest2,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 24,
        error_budget_remaining_bps: 8077,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "aurora-energy",
        service: "forecast-worker",
        version: "4.16.2",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 3,
        error_budget_remaining_bps: 8214,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "aurora-energy",
        service: "grid-console",
        version: "5.19.9",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 4,
        error_budget_remaining_bps: 8351,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "summit-travel",
        service: "booking-api",
        version: "2.22.16",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 5,
        error_budget_remaining_bps: 8488,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "summit-travel",
        service: "inventory-sync",
        version: "3.25.4",
        environment: Environment::Staging,
        region: Region::UsEast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 6,
        error_budget_remaining_bps: 8625,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "summit-travel",
        service: "fare-engine",
        version: "4.28.11",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 7,
        error_budget_remaining_bps: 8762,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "summit-travel",
        service: "agent-portal",
        version: "5.31.18",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 8,
        error_budget_remaining_bps: 8899,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "harbor-cloud",
        service: "identity-api",
        version: "2.34.6",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 9,
        error_budget_remaining_bps: 9036,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "harbor-cloud",
        service: "quota-controller",
        version: "3.37.13",
        environment: Environment::Staging,
        region: Region::ApNortheast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 10,
        error_budget_remaining_bps: 9173,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "harbor-cloud",
        service: "usage-aggregator",
        version: "4.10.1",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 11,
        error_budget_remaining_bps: 9310,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "harbor-cloud",
        service: "admin-console",
        version: "5.13.8",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 12,
        error_budget_remaining_bps: 9447,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "willow-learning",
        service: "course-api",
        version: "2.16.15",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 13,
        error_budget_remaining_bps: 5284,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "willow-learning",
        service: "assessment-worker",
        version: "3.19.3",
        environment: Environment::Staging,
        region: Region::ApSoutheast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 14,
        error_budget_remaining_bps: 5421,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "willow-learning",
        service: "progress-stream",
        version: "4.22.10",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 15,
        error_budget_remaining_bps: 5558,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "willow-learning",
        service: "teacher-console",
        version: "5.25.17",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 16,
        error_budget_remaining_bps: 5695,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "ember-games",
        service: "matchmaker-api",
        version: "2.28.5",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 17,
        error_budget_remaining_bps: 5832,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "ember-games",
        service: "session-director",
        version: "3.31.12",
        environment: Environment::Staging,
        region: Region::EuWest1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 18,
        error_budget_remaining_bps: 5969,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "ember-games",
        service: "economy-worker",
        version: "4.34.0",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 19,
        error_budget_remaining_bps: 6106,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "ember-games",
        service: "liveops-console",
        version: "5.37.7",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 20,
        error_budget_remaining_bps: 6243,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "lumen-security",
        service: "policy-api",
        version: "2.10.14",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 21,
        error_budget_remaining_bps: 6380,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "lumen-security",
        service: "event-correlator",
        version: "3.13.2",
        environment: Environment::Staging,
        region: Region::UsWest2,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 22,
        error_budget_remaining_bps: 6517,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "lumen-security",
        service: "sensor-gateway",
        version: "4.16.9",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 23,
        error_budget_remaining_bps: 6654,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "lumen-security",
        service: "analyst-console",
        version: "5.19.16",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 24,
        error_budget_remaining_bps: 6791,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "meadow-foods",
        service: "order-api",
        version: "2.22.4",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 3,
        error_budget_remaining_bps: 6928,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "meadow-foods",
        service: "kitchen-dispatch",
        version: "3.25.11",
        environment: Environment::Staging,
        region: Region::UsEast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 4,
        error_budget_remaining_bps: 7065,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "meadow-foods",
        service: "delivery-planner",
        version: "4.28.18",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 5,
        error_budget_remaining_bps: 7202,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "meadow-foods",
        service: "merchant-console",
        version: "5.31.6",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 6,
        error_budget_remaining_bps: 7339,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "vector-mobility",
        service: "trip-api",
        version: "2.34.13",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 7,
        error_budget_remaining_bps: 7476,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "vector-mobility",
        service: "dispatch-engine",
        version: "3.37.1",
        environment: Environment::Staging,
        region: Region::ApNortheast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 8,
        error_budget_remaining_bps: 7613,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "vector-mobility",
        service: "telemetry-stream",
        version: "4.10.8",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 9,
        error_budget_remaining_bps: 7750,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "vector-mobility",
        service: "fleet-console",
        version: "5.13.15",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 10,
        error_budget_remaining_bps: 7887,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "quartz-insurance",
        service: "policy-api",
        version: "2.16.3",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 11,
        error_budget_remaining_bps: 8024,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "quartz-insurance",
        service: "claims-orchestrator",
        version: "3.19.10",
        environment: Environment::Staging,
        region: Region::ApSoutheast1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 12,
        error_budget_remaining_bps: 8161,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "quartz-insurance",
        service: "risk-worker",
        version: "4.22.17",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 13,
        error_budget_remaining_bps: 8298,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "quartz-insurance",
        service: "broker-portal",
        version: "5.25.5",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 14,
        error_budget_remaining_bps: 8435,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "ripple-commerce",
        service: "cart-api",
        version: "2.28.12",
        environment: Environment::Production,
        region: Region::UsWest2,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 15,
        error_budget_remaining_bps: 8572,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "ripple-commerce",
        service: "promotion-engine",
        version: "3.31.0",
        environment: Environment::Staging,
        region: Region::EuWest1,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 16,
        error_budget_remaining_bps: 8709,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "ripple-commerce",
        service: "fulfillment-worker",
        version: "4.34.7",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 17,
        error_budget_remaining_bps: 8846,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "ripple-commerce",
        service: "seller-console",
        version: "5.37.14",
        environment: Environment::Production,
        region: Region::ApNortheast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 18,
        error_budget_remaining_bps: 8983,
        approval_count: 4,
    },
    FixtureSeed {
        tenant: "pine-analytics",
        service: "query-api",
        version: "2.10.2",
        environment: Environment::Production,
        region: Region::UsEast1,
        risk: RiskTier::Medium,
        strategy: FixtureStrategy::Canary,
        desired_replicas: 19,
        error_budget_remaining_bps: 9120,
        approval_count: 1,
    },
    FixtureSeed {
        tenant: "pine-analytics",
        service: "ingest-worker",
        version: "3.13.9",
        environment: Environment::Staging,
        region: Region::UsWest2,
        risk: RiskTier::High,
        strategy: FixtureStrategy::Linear,
        desired_replicas: 20,
        error_budget_remaining_bps: 9257,
        approval_count: 2,
    },
    FixtureSeed {
        tenant: "pine-analytics",
        service: "segment-builder",
        version: "4.16.16",
        environment: Environment::Production,
        region: Region::EuWest1,
        risk: RiskTier::Low,
        strategy: FixtureStrategy::BlueGreen,
        desired_replicas: 21,
        error_budget_remaining_bps: 9394,
        approval_count: 3,
    },
    FixtureSeed {
        tenant: "pine-analytics",
        service: "workspace-web",
        version: "5.19.4",
        environment: Environment::Production,
        region: Region::ApSoutheast1,
        risk: RiskTier::Critical,
        strategy: FixtureStrategy::FeatureFlag,
        desired_replicas: 22,
        error_budget_remaining_bps: 5231,
        approval_count: 4,
    },
    ]
}

fn release_from_fixture(seed: FixtureSeed, sequence: u32) -> Result<ReleaseSpec, FleetError> {
    let tenant = TenantId::parse(seed.tenant)?;
    let service = ServiceId::parse(seed.service)?;
    let digest_material = audit_checksum(&[
        seed.tenant,
        seed.service,
        seed.version,
        seed.region.code(),
    ]);
    Ok(ReleaseSpec {
        tenant: tenant.clone(),
        service: service.clone(),
        version: SemanticVersion::parse(seed.version)?,
        sequence,
        risk: seed.risk,
        strategy: seed.strategy.materialize(&tenant, &service),
        targets: vec![DeploymentTarget {
            environment: seed.environment,
            region: seed.region,
            cluster: format!("{}-{}-primary", seed.tenant, seed.region.code()),
            desired_replicas: seed.desired_replicas,
        }],
        artifact: Artifact {
            image_digest: format!(
                "sha256:{digest_material:016x}{:016x}",
                digest_material.rotate_left(17)
            ),
            provenance_attestation: format!(
                "https://attest.kiron.example/{}/{}/{}",
                seed.tenant, seed.service, seed.version
            ),
            sbom_uri: format!(
                "https://sbom.kiron.example/{}/{}/{}.spdx.json",
                seed.tenant, seed.service, seed.version
            ),
            rollback_digest: Some(format!(
                "sha256:{:016x}{:016x}",
                digest_material.rotate_right(11),
                digest_material.rotate_left(7)
            )),
        },
        change_ticket: format!("CHG-{:06}", sequence + 41_000),
    })
}

fn policy_context(seed: FixtureSeed) -> PolicyContext {
    let approvals = (0..seed.approval_count)
        .map(|index| format!("user:release-approver-{}", index + 1))
        .collect();
    PolicyContext {
        actor: "service:release-bot".to_owned(),
        approvals,
        maintenance_window_open: true,
        error_budget_remaining_bps: seed.error_budget_remaining_bps,
        freeze_active: false,
        emergency_override_ticket: None,
    }
}

fn validate_fixture_catalog() -> Result<usize, FleetError> {
    let mut identities = BTreeSet::new();
    for (index, seed) in fixture_seeds().iter().copied().enumerate() {
        let spec = release_from_fixture(seed, index as u32 + 1)?;
        spec.validate()?;
        let identity = format!(
            "{}/{}/{}",
            spec.tenant, spec.service, spec.version
        );
        if !identities.insert(identity.clone()) {
            return Err(FleetError::DuplicateTarget(identity));
        }
        let plan = RolloutPlanner::build(&spec)?;
        if plan.stages.is_empty() {
            return Err(FleetError::InvalidStrategy(
                "fixture generated an empty plan".to_owned(),
            ));
        }
    }
    Ok(identities.len())
}

fn run_demo() -> Result<(), FleetError> {
    let seed = fixture_seeds()[0];
    let spec = release_from_fixture(seed, 1)?;
    let context = policy_context(seed);
    let mut controller = FleetController::new(
        InMemoryStore::default(),
        PolicyEngine::production_default(),
    );
    let plan = controller.submit(spec, &context)?;
    controller.transition(
        &plan.release_id,
        ReleasePhase::Queued,
        "service:release-bot",
        "capacity reservation acquired",
    )?;
    controller.transition(
        &plan.release_id,
        ReleasePhase::Deploying,
        "service:release-bot",
        "first canary stage started",
    )?;
    controller.transition(
        &plan.release_id,
        ReleasePhase::Observing,
        "service:release-bot",
        "all traffic stages reached target",
    )?;
    controller.transition(
        &plan.release_id,
        ReleasePhase::Completed,
        "service:release-bot",
        "SLO gates remained healthy throughout soak",
    )?;

    let record = controller.store.release(&plan.release_id)?;
    println!(
        "{} {}/{}@{} {:?}: {} stage(s), {} audit event(s)",
        record.id,
        record.spec.tenant,
        record.spec.service,
        record.spec.version,
        record.phase,
        plan.stages.len(),
        controller.store.audits().len()
    );
    Ok(())
}

fn main() -> Result<(), Box<dyn Error>> {
    match std::env::args().nth(1).as_deref() {
        Some("fixtures") => {
            let count = validate_fixture_catalog()?;
            println!("validated {count} Kiron Fleet fixture releases");
        }
        Some("demo") | None => run_demo()?,
        Some(command) => {
            eprintln!("unknown command {command:?}; expected demo or fixtures");
            std::process::exit(2);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semantic_version_round_trip() {
        let version = SemanticVersion::parse("4.12.9-rc.2").expect("valid version");
        assert_eq!(version.to_string(), "4.12.9-rc.2");
    }

    #[test]
    fn release_state_machine_rejects_skips() {
        let spec = release_from_fixture(fixture_seeds()[0], 1).expect("fixture");
        let mut record = ReleaseRecord::new(spec);
        let error = record
            .transition(ReleasePhase::Deploying, 1, "skip validation")
            .expect_err("transition should fail");
        assert!(matches!(error, FleetError::InvalidTransition { .. }));
    }

    #[test]
    fn production_policy_requires_rollback_and_approvals() {
        let mut spec = release_from_fixture(fixture_seeds()[0], 2).expect("fixture");
        spec.artifact.rollback_digest = None;
        let context = PolicyContext {
            actor: "user:operator".to_owned(),
            approvals: BTreeSet::new(),
            maintenance_window_open: true,
            error_budget_remaining_bps: 9_000,
            freeze_active: false,
            emergency_override_ticket: None,
        };
        let decision = PolicyEngine::production_default().evaluate(&spec, &context);
        assert!(!decision.allowed);
        assert!(decision.reasons.iter().any(|reason| reason.contains("rollback")));
    }

    #[test]
    fn feature_flag_rule_precedes_default() {
        let tenant = TenantId::parse("northwind-retail").expect("tenant");
        let flag = FeatureFlag {
            key: "checkout-api.new-router".to_owned(),
            owner: "team:checkout".to_owned(),
            default_enabled: false,
            rules: vec![FlagRule {
                description: "enable for the canary tenant".to_owned(),
                all: vec![
                    FlagPredicate::Tenant(tenant.clone()),
                    FlagPredicate::Percentage(1_000),
                ],
                enabled: true,
            }],
        };
        let context = FlagContext {
            tenant,
            region: Region::UsEast1,
            environment: Environment::Production,
            account_tags: BTreeSet::new(),
            stable_bucket: 42,
        };
        assert!(flag.evaluate(&context));
    }

    #[test]
    fn slo_evaluation_detects_budget_exhaustion() {
        let slo = SloDefinition {
            name: "checkout availability".to_owned(),
            target_basis_points: 9_995,
            window_minutes: 30,
            minimum_requests: 1_000,
        };
        let sample = SloSample {
            total_requests: 20_000,
            successful_requests: 19_998,
            p95_latency_ms: 180,
            error_budget_remaining_bps: 320,
        };
        assert_eq!(slo.evaluate(&sample), SloState::Breached);
    }

    #[test]
    fn audit_chain_rejects_wrong_parent_checksum() {
        let tenant = TenantId::parse("atlas-banking").expect("tenant");
        let mut store = InMemoryStore::default();
        let invalid = AuditEvent::new(
            1,
            1_700_000_000_000,
            tenant,
            "user:operator",
            "release.submit",
            "service/payments-gateway",
            "allow",
            99,
        );
        assert!(matches!(
            store.append_audit(invalid),
            Err(FleetError::InvalidAuditChain)
        ));
    }

    #[test]
    fn rollout_plan_always_finishes_at_full_traffic() {
        for (index, seed) in fixture_seeds().iter().copied().enumerate() {
            let spec = release_from_fixture(seed, index as u32 + 1).expect("fixture");
            let plan = RolloutPlanner::build(&spec).expect("plan");
            assert_eq!(
                plan.stages.last().map(|stage| stage.traffic_percent),
                Some(100)
            );
        }
    }

    #[test]
    fn fixture_catalog_is_large_and_unique() {
        let count = validate_fixture_catalog().expect("catalog");
        assert!(count >= 64);
    }
}
