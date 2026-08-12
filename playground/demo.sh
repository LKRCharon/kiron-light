#!/usr/bin/env bash
#
# Kiron Fleet Control Plane release and diagnostic CLI.
# Mutating calls require --execute and confirmation; plan is read-only.

set -Eeuo pipefail
IFS=$'\n\t'

readonly PROGRAM_NAME="kiron-fleet"
readonly PROGRAM_VERSION="0.8.0"
readonly DEFAULT_API_URL="https://fleet-api.kiron.example"

COMMAND="plan"
TENANT=""
SERVICE=""
OWNER=""
VERSION=""
ENVIRONMENT="production"
REGION="us-east-1"
STRATEGY="canary"
RISK_TIER="medium"
REQUIRED_APPROVALS="1"
REPLICAS="3"
CANARY_PERCENT="1"
SOAK_SECONDS="300"
ERROR_BUDGET_FLOOR_BPS="2500"
CHANGE_TICKET=""
RELEASE_ID=""
FIXTURE_ID=""
ROLLBACK_REASON=""
API_URL="${KIRON_FLEET_API_URL:-${DEFAULT_API_URL}}"
API_TOKEN="${KIRON_FLEET_TOKEN:-}"
TIMEOUT_SECONDS="${KIRON_FLEET_TIMEOUT_SECONDS:-15}"
POLL_SECONDS="${KIRON_FLEET_POLL_SECONDS:-10}"
MAX_POLLS="${KIRON_FLEET_MAX_POLLS:-60}"
LOG_LEVEL="${KIRON_FLEET_LOG_LEVEL:-info}"
OUTPUT_FORMAT="text"
EXECUTE="false"
ASSUME_YES="false"
SKIP_SLO_WAIT="false"
TRACE_HTTP="false"
PLAN_FILE=""
LOCK_DIR=""
LAST_HTTP_STATUS=""
LAST_HTTP_BODY=""

usage() {
  printf '%s %s\n\n' "${PROGRAM_NAME}" "${PROGRAM_VERSION}"
  cat <<'USAGE'
Kiron Fleet Control Plane CLI

Usage:
  demo.sh plan [options]
  demo.sh release [options]
  demo.sh rollback --release-id ID --reason TEXT [options]
  demo.sh diagnose [options]
  demo.sh fixtures [--fixture ID]
  demo.sh self-test

Options:
  --tenant SLUG
  --service SLUG
  --version X.Y.Z
  --environment development|staging|production
  --region REGION
  --strategy canary|linear|blue-green|feature-flag
  --risk low|medium|high|critical
  --replicas COUNT
  --change-ticket ID
  --fixture ID
  --api-url URL
  --output text|json
  --plan-file PATH
  --execute
  --yes
  --skip-slo-wait
  --trace-http
  --debug
  -h, --help

Safety: release and rollback are dry-run operations unless --execute is set.
The token comes from KIRON_FLEET_TOKEN and is never written to logs.
USAGE
}

timestamp() {
  date -u '+%Y-%m-%dT%H:%M:%SZ'
}

level_number() {
  case "$1" in
    debug) printf '10' ;;
    info) printf '20' ;;
    warn) printf '30' ;;
    error) printf '40' ;;
    *) printf '20' ;;
  esac
}

log() {
  local level="$1"
  shift
  if [ "$(level_number "${level}")" -ge "$(level_number "${LOG_LEVEL}")" ]; then
    printf '%s level=%s component=%s message=%q\n' \
      "$(timestamp)" "${level}" "${PROGRAM_NAME}" "$*" >&2
  fi
}

die() {
  log error "$*"
  exit 1
}

release_lock() {
  if [ -n "${LOCK_DIR}" ] && [ -d "${LOCK_DIR}" ]; then
    rm -f "${LOCK_DIR}/pid"
    rmdir "${LOCK_DIR}" 2>/dev/null || true
    LOCK_DIR=""
  fi
}

on_error() {
  local code=$?
  log error "command failed at line ${1:-unknown} with exit ${code}"
  release_lock
  exit "${code}"
}

trap 'on_error ${LINENO}' ERR
trap 'release_lock' EXIT INT TERM

require_value() {
  [ -n "${2:-}" ] || die "$1 requires a value"
}

is_slug() {
  case "$1" in
    ""|"-"*|*"-"|*[!a-z0-9-]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_uint() {
  case "$1" in
    ""|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

is_semver() {
  local base="${1%%-*}"
  local major="${base%%.*}"
  local rest="${base#*.}"
  local minor="${rest%%.*}"
  local patch="${rest#*.}"
  [ "${base}" != "${major}" ] &&
    [ "${rest}" != "${minor}" ] &&
    is_uint "${major}" &&
    is_uint "${minor}" &&
    is_uint "${patch}"
}

required_approvals_for_risk() {
  case "$1" in
    low|medium) printf '1' ;;
    high) printf '2' ;;
    critical) printf '3' ;;
    *) die "invalid risk tier: $1" ;;
  esac
}

parse_arguments() {
  if [ "$#" -gt 0 ]; then
    case "$1" in
      plan|release|rollback|diagnose|fixtures|self-test)
        COMMAND="$1"
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        die "unknown command: $1"
        ;;
    esac
  fi
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --tenant) require_value "$1" "${2:-}"; TENANT="$2"; shift 2 ;;
      --service) require_value "$1" "${2:-}"; SERVICE="$2"; shift 2 ;;
      --owner) require_value "$1" "${2:-}"; OWNER="$2"; shift 2 ;;
      --version) require_value "$1" "${2:-}"; VERSION="$2"; shift 2 ;;
      --environment) require_value "$1" "${2:-}"; ENVIRONMENT="$2"; shift 2 ;;
      --region) require_value "$1" "${2:-}"; REGION="$2"; shift 2 ;;
      --strategy) require_value "$1" "${2:-}"; STRATEGY="$2"; shift 2 ;;
      --risk) require_value "$1" "${2:-}"; RISK_TIER="$2"; shift 2 ;;
      --replicas) require_value "$1" "${2:-}"; REPLICAS="$2"; shift 2 ;;
      --canary-percent) require_value "$1" "${2:-}"; CANARY_PERCENT="$2"; shift 2 ;;
      --soak-seconds) require_value "$1" "${2:-}"; SOAK_SECONDS="$2"; shift 2 ;;
      --error-budget-floor-bps) require_value "$1" "${2:-}"; ERROR_BUDGET_FLOOR_BPS="$2"; shift 2 ;;
      --change-ticket) require_value "$1" "${2:-}"; CHANGE_TICKET="$2"; shift 2 ;;
      --release-id) require_value "$1" "${2:-}"; RELEASE_ID="$2"; shift 2 ;;
      --reason) require_value "$1" "${2:-}"; ROLLBACK_REASON="$2"; shift 2 ;;
      --fixture) require_value "$1" "${2:-}"; FIXTURE_ID="$2"; shift 2 ;;
      --api-url) require_value "$1" "${2:-}"; API_URL="${2%/}"; shift 2 ;;
      --output) require_value "$1" "${2:-}"; OUTPUT_FORMAT="$2"; shift 2 ;;
      --plan-file) require_value "$1" "${2:-}"; PLAN_FILE="$2"; shift 2 ;;
      --timeout) require_value "$1" "${2:-}"; TIMEOUT_SECONDS="$2"; shift 2 ;;
      --execute) EXECUTE="true"; shift ;;
      --yes) ASSUME_YES="true"; shift ;;
      --skip-slo-wait) SKIP_SLO_WAIT="true"; shift ;;
      --trace-http) TRACE_HTTP="true"; shift ;;
      --debug) LOG_LEVEL="debug"; shift ;;
      -h|--help) usage; exit 0 ;;
      --) shift; break ;;
      *) die "unknown option: $1" ;;
    esac
  done
}

validate_inputs() {
  is_slug "${TENANT}" || die "invalid tenant slug: ${TENANT}"
  is_slug "${SERVICE}" || die "invalid service slug: ${SERVICE}"
  is_semver "${VERSION}" || die "invalid semantic version: ${VERSION}"
  case "${ENVIRONMENT}" in development|staging|production) ;; *) die "invalid environment" ;; esac
  case "${REGION}" in
    us-east-1|us-west-2|eu-west-1|ap-southeast-1|ap-northeast-1) ;;
    *) die "unsupported region: ${REGION}" ;;
  esac
  case "${STRATEGY}" in canary|linear|blue-green|feature-flag) ;; *) die "invalid strategy" ;; esac
  REQUIRED_APPROVALS="$(required_approvals_for_risk "${RISK_TIER}")"
  is_uint "${REPLICAS}" || die "replicas must be an integer"
  is_uint "${CANARY_PERCENT}" || die "canary percent must be an integer"
  is_uint "${SOAK_SECONDS}" || die "soak seconds must be an integer"
  is_uint "${ERROR_BUDGET_FLOOR_BPS}" || die "error budget floor must be an integer"
  [ "${REPLICAS}" -gt 0 ] || die "replicas must be greater than zero"
  [ "${CANARY_PERCENT}" -ge 1 ] && [ "${CANARY_PERCENT}" -le 25 ] ||
    die "canary percent must be in 1..25"
  if [ "${ENVIRONMENT}" = "production" ] && [ -z "${CHANGE_TICKET}" ]; then
    die "production releases require a change ticket"
  fi
  case "${OUTPUT_FORMAT}" in text|json) ;; *) die "output must be text or json" ;; esac
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

sha256_text() {
  if command_exists shasum; then
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  elif command_exists sha256sum; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    die "SHA-256 utility not found"
  fi
}

json_escape() {
  local input="$1"
  input="${input//\\/\\\\}"
  input="${input//\"/\\\"}"
  input="${input//$'\n'/\\n}"
  input="${input//$'\r'/\\r}"
  input="${input//$'\t'/\\t}"
  printf '%s' "${input}"
}

urlencode() {
  local input="$1"
  local output=""
  local index=0
  local character
  while [ "${index}" -lt "${#input}" ]; do
    character="${input:${index}:1}"
    case "${character}" in
      [a-zA-Z0-9.~_-]) output="${output}${character}" ;;
      *) printf -v character '%%%02X' "'${character}"; output="${output}${character}" ;;
    esac
    index=$((index + 1))
  done
  printf '%s' "${output}"
}

release_fingerprint() {
  sha256_text "${TENANT}|${SERVICE}|${VERSION}|${ENVIRONMENT}|${REGION}|${STRATEGY}"
}

make_release_id() {
  local fingerprint
  fingerprint="$(release_fingerprint)"
  printf 'rel-%s-%s-%.12s' "${TENANT}" "${SERVICE}" "${fingerprint}"
}

render_stages() {
  case "${STRATEGY}" in
    canary)
      printf '%s\n' \
        "preflight traffic=0 soak=0 approval=yes" \
        "canary traffic=${CANARY_PERCENT} soak=${SOAK_SECONDS} approval=no" \
        "regional-ramp traffic=10 soak=${SOAK_SECONDS} approval=no" \
        "half-traffic traffic=50 soak=${SOAK_SECONDS} approval=yes" \
        "full-traffic traffic=100 soak=${SOAK_SECONDS} approval=yes"
      ;;
    linear)
      printf '%s\n' \
        "preflight traffic=0 soak=0 approval=yes" \
        "linear-20 traffic=20 soak=${SOAK_SECONDS} approval=no" \
        "linear-40 traffic=40 soak=${SOAK_SECONDS} approval=no" \
        "linear-60 traffic=60 soak=${SOAK_SECONDS} approval=no" \
        "linear-80 traffic=80 soak=${SOAK_SECONDS} approval=yes" \
        "full-traffic traffic=100 soak=${SOAK_SECONDS} approval=yes"
      ;;
    blue-green)
      printf '%s\n' \
        "green-deploy traffic=0 soak=${SOAK_SECONDS} approval=no" \
        "synthetic-probe traffic=0 soak=${SOAK_SECONDS} approval=yes" \
        "traffic-switch traffic=100 soak=${SOAK_SECONDS} approval=yes"
      ;;
    feature-flag)
      printf '%s\n' \
        "dark-launch traffic=0 soak=${SOAK_SECONDS} approval=no" \
        "internal traffic=1 soak=${SOAK_SECONDS} approval=no" \
        "tenant-canary traffic=10 soak=${SOAK_SECONDS} approval=no" \
        "broad-ramp traffic=50 soak=${SOAK_SECONDS} approval=yes" \
        "general-available traffic=100 soak=${SOAK_SECONDS} approval=yes"
      ;;
  esac
}

render_plan_text() {
  printf 'Kiron Fleet release plan\n'
  printf '  release: %s\n' "$(make_release_id)"
  printf '  target: %s/%s/%s/%s\n' "${TENANT}" "${SERVICE}" "${ENVIRONMENT}" "${REGION}"
  printf '  artifact: %s:%s\n' "${SERVICE}" "${VERSION}"
  printf '  owner: %s\n' "${OWNER:-unassigned}"
  printf '  strategy: %s\n' "${STRATEGY}"
  printf '  risk: %s; approvals=%s\n' "${RISK_TIER}" "${REQUIRED_APPROVALS}"
  printf '  replicas: %s\n' "${REPLICAS}"
  printf '  error-budget-floor-bps: %s\n' "${ERROR_BUDGET_FLOOR_BPS}"
  printf '  change-ticket: %s\n' "${CHANGE_TICKET:-not-required}"
  printf '  fingerprint: %s\n' "$(release_fingerprint)"
  printf 'Stages:\n'
  render_stages | sed 's/^/  /'
}

render_plan_json() {
  printf '{\n'
  printf '  "releaseId": "%s",\n' "$(make_release_id)"
  printf '  "tenant": "%s",\n' "$(json_escape "${TENANT}")"
  printf '  "service": "%s",\n' "$(json_escape "${SERVICE}")"
  printf '  "version": "%s",\n' "$(json_escape "${VERSION}")"
  printf '  "environment": "%s",\n' "$(json_escape "${ENVIRONMENT}")"
  printf '  "region": "%s",\n' "$(json_escape "${REGION}")"
  printf '  "strategy": "%s",\n' "$(json_escape "${STRATEGY}")"
  printf '  "riskTier": "%s",\n' "$(json_escape "${RISK_TIER}")"
  printf '  "requiredApprovals": %s,\n' "${REQUIRED_APPROVALS}"
  printf '  "desiredReplicas": %s,\n' "${REPLICAS}"
  printf '  "changeTicket": "%s"\n' "$(json_escape "${CHANGE_TICKET}")"
  printf '}\n'
}

print_plan() {
  if [ "${OUTPUT_FORMAT}" = "json" ]; then
    render_plan_json
  else
    render_plan_text
  fi
  if [ -n "${PLAN_FILE}" ]; then
    local temporary="${PLAN_FILE}.tmp.$$"
    if [ "${OUTPUT_FORMAT}" = "json" ]; then
      render_plan_json >"${temporary}"
    else
      render_plan_text >"${temporary}"
    fi
    mv "${temporary}" "${PLAN_FILE}"
    log info "wrote plan to ${PLAN_FILE}"
  fi
}

preflight() {
  local tool
  for tool in curl awk sed date mktemp; do
    command_exists "${tool}" || die "required tool missing: ${tool}"
  done
  if [ "${EXECUTE}" = "true" ]; then
    [ -n "${API_TOKEN}" ] || die "KIRON_FLEET_TOKEN is required with --execute"
    curl --fail --silent --show-error \
      --connect-timeout "${TIMEOUT_SECONDS}" \
      --max-time "${TIMEOUT_SECONDS}" \
      "${API_URL}/v1/health" >/dev/null
  fi
}

acquire_lock() {
  LOCK_DIR="${TMPDIR:-/tmp}/kiron-fleet-$(release_fingerprint).lock"
  mkdir "${LOCK_DIR}" 2>/dev/null || die "another release holds ${LOCK_DIR}"
  printf '%s\n' "$$" >"${LOCK_DIR}/pid"
}

confirm_mutation() {
  if [ "${EXECUTE}" != "true" ]; then
    log info "dry-run complete; pass --execute to mutate the control plane"
    return 1
  fi
  if [ "${ASSUME_YES}" = "true" ]; then
    return 0
  fi
  [ -t 0 ] || die "confirmation requires a terminal or --yes"
  local answer
  printf 'Type %s/%s to continue: ' "${TENANT}" "${SERVICE}" >&2
  IFS= read -r answer
  [ "${answer}" = "${TENANT}/${SERVICE}" ] || die "confirmation did not match"
}

http_request() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local response_file
  response_file="$(mktemp "${TMPDIR:-/tmp}/kiron-http.XXXXXX")"
  [ "${TRACE_HTTP}" = "false" ] || log debug "${method} ${API_URL}${path}"
  local args=(
    --silent
    --show-error
    --connect-timeout "${TIMEOUT_SECONDS}"
    --max-time "${TIMEOUT_SECONDS}"
    --request "${method}"
    --header "Accept: application/json"
    --header "Authorization: Bearer ${API_TOKEN}"
    --output "${response_file}"
    --write-out "%{http_code}"
  )
  if [ -n "${body}" ]; then
    args+=(--header "Content-Type: application/json" --data "${body}")
  fi
  LAST_HTTP_STATUS="$(curl "${args[@]}" "${API_URL}${path}")"
  LAST_HTTP_BODY="$(<"${response_file}")"
  rm -f "${response_file}"
  case "${LAST_HTTP_STATUS}" in
    2??) return 0 ;;
    *) log error "HTTP ${LAST_HTTP_STATUS}: ${LAST_HTTP_BODY}"; return 1 ;;
  esac
}

release_payload() {
  printf '{'
  printf '"tenant":"%s",' "$(json_escape "${TENANT}")"
  printf '"service":"%s",' "$(json_escape "${SERVICE}")"
  printf '"version":"%s",' "$(json_escape "${VERSION}")"
  printf '"environment":"%s",' "$(json_escape "${ENVIRONMENT}")"
  printf '"region":"%s",' "$(json_escape "${REGION}")"
  printf '"strategy":"%s",' "$(json_escape "${STRATEGY}")"
  printf '"riskTier":"%s",' "$(json_escape "${RISK_TIER}")"
  printf '"desiredReplicas":%s,' "${REPLICAS}"
  printf '"canaryPercent":%s,' "${CANARY_PERCENT}"
  printf '"soakSeconds":%s,' "${SOAK_SECONDS}"
  printf '"changeTicket":"%s"' "$(json_escape "${CHANGE_TICKET}")"
  printf '}'
}

wait_for_slo() {
  [ "${SKIP_SLO_WAIT}" = "false" ] || return 0
  local poll=1
  while [ "${poll}" -le "${MAX_POLLS}" ]; do
    http_request GET "/v1/releases/$(urlencode "${RELEASE_ID}")"
    case "${LAST_HTTP_BODY}" in
      *'"state":"healthy"'*) log info "SLO gate healthy"; return 0 ;;
      *'"state":"breached"'*|*'"state":"rollback_required"'*) return 1 ;;
      *) log debug "observing release; poll ${poll}/${MAX_POLLS}" ;;
    esac
    sleep "${POLL_SECONDS}"
    poll=$((poll + 1))
  done
  return 1
}

execute_rollback() {
  [ -n "${RELEASE_ID}" ] || die "rollback requires --release-id"
  [ -n "${ROLLBACK_REASON}" ] || die "rollback requires --reason"
  if [ "${EXECUTE}" != "true" ]; then
    log info "rollback dry-run release=${RELEASE_ID} reason=${ROLLBACK_REASON}"
    return 0
  fi
  preflight
  acquire_lock
  http_request POST "/v1/releases/$(urlencode "${RELEASE_ID}")/rollback" \
    "{\"reason\":\"$(json_escape "${ROLLBACK_REASON}")\",\"changeTicket\":\"$(json_escape "${CHANGE_TICKET}")\"}"
  log warn "rollback requested for ${RELEASE_ID}"
}

execute_release() {
  print_plan
  confirm_mutation || return 0
  preflight
  acquire_lock
  RELEASE_ID="$(make_release_id)"
  http_request POST "/v1/tenants/$(urlencode "${TENANT}")/releases" "$(release_payload)"
  if ! wait_for_slo; then
    ROLLBACK_REASON="automatic rollback after SLO breach"
    execute_rollback
    return 1
  fi
  log info "release completed: ${RELEASE_ID}"
}

diagnose() {
  local host="${API_URL#*://}"
  host="${host%%/*}"
  printf 'Kiron Fleet diagnostics\n'
  printf '  timestamp: %s\n' "$(timestamp)"
  printf '  api: %s\n' "${API_URL}"
  printf '  tenant: %s\n' "${TENANT:-unset}"
  printf '  service: %s\n' "${SERVICE:-unset}"
  printf '  release: %s\n' "${RELEASE_ID:-unset}"
  printf '  token: %s\n' "$([ -n "${API_TOKEN}" ] && printf configured || printf missing)"
  if command_exists dscacheutil; then
    dscacheutil -q host -a name "${host}" || true
  elif command_exists getent; then
    getent hosts "${host}" || true
  fi
  curl --silent --show-error --output /dev/null \
    --connect-timeout "${TIMEOUT_SECONDS}" \
    --max-time "${TIMEOUT_SECONDS}" \
    --write-out 'status=%{http_code} remote=%{remote_ip} tls=%{ssl_verify_result} total=%{time_total}\n' \
    "${API_URL}/v1/health" || true
}

assert_equal() {
  [ "$1" = "$2" ] || die "self-test failed: $3; expected $1, got $2"
}

self_test() {
  load_fixture "001"
  validate_inputs
  assert_equal "northwind-retail" "${TENANT}" "fixture tenant"
  assert_equal "checkout-api" "${SERVICE}" "fixture service"
  assert_equal "1" "${REQUIRED_APPROVALS}" "approval count"
  [ "$(release_fingerprint | wc -c | tr -d ' ')" -eq 65 ] ||
    die "self-test failed: SHA-256 output length"
  render_stages | grep -q 'full-traffic' ||
    die "self-test failed: rollout does not reach full traffic"
  printf 'self-test passed: fixture, validation, hashing, and planning\n'
}

fixture_001_northwind_retail_checkout_api() {
  TENANT="northwind-retail"
  SERVICE="checkout-api"
  OWNER="team:commerce"
  VERSION="2.10.0"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 0))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 0))"
}

fixture_002_northwind_retail_catalog_api() {
  TENANT="northwind-retail"
  SERVICE="catalog-api"
  OWNER="team:commerce"
  VERSION="3.13.7"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 1))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 1))"
}

fixture_003_northwind_retail_pricing_worker() {
  TENANT="northwind-retail"
  SERVICE="pricing-worker"
  OWNER="team:commerce"
  VERSION="4.16.14"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 2))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 2))"
}

fixture_004_northwind_retail_storefront_web() {
  TENANT="northwind-retail"
  SERVICE="storefront-web"
  OWNER="team:commerce"
  VERSION="5.19.2"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 3))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 3))"
}

fixture_005_atlas_banking_ledger_api() {
  TENANT="atlas-banking"
  SERVICE="ledger-api"
  OWNER="team:payments"
  VERSION="2.22.9"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 4))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 4))"
}

fixture_006_atlas_banking_payments_gateway() {
  TENANT="atlas-banking"
  SERVICE="payments-gateway"
  OWNER="team:payments"
  VERSION="3.25.16"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 5))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 5))"
}

fixture_007_atlas_banking_fraud_scorer() {
  TENANT="atlas-banking"
  SERVICE="fraud-scorer"
  OWNER="team:payments"
  VERSION="4.28.4"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 6))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 6))"
}

fixture_008_atlas_banking_customer_portal() {
  TENANT="atlas-banking"
  SERVICE="customer-portal"
  OWNER="team:payments"
  VERSION="5.31.11"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 7))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 7))"
}

fixture_009_helios_health_patient_api() {
  TENANT="helios-health"
  SERVICE="patient-api"
  OWNER="team:care-platform"
  VERSION="2.34.18"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 8))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 8))"
}

fixture_010_helios_health_claims_worker() {
  TENANT="helios-health"
  SERVICE="claims-worker"
  OWNER="team:care-platform"
  VERSION="3.37.6"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 9))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 9))"
}

fixture_011_helios_health_scheduling_api() {
  TENANT="helios-health"
  SERVICE="scheduling-api"
  OWNER="team:care-platform"
  VERSION="4.10.13"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 10))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 10))"
}

fixture_012_helios_health_care_console() {
  TENANT="helios-health"
  SERVICE="care-console"
  OWNER="team:care-platform"
  VERSION="5.13.1"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 11))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 11))"
}

fixture_013_orion_logistics_routing_engine() {
  TENANT="orion-logistics"
  SERVICE="routing-engine"
  OWNER="team:fulfillment"
  VERSION="2.16.8"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 12))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 12))"
}

fixture_014_orion_logistics_shipment_api() {
  TENANT="orion-logistics"
  SERVICE="shipment-api"
  OWNER="team:fulfillment"
  VERSION="3.19.15"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 13))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 13))"
}

fixture_015_orion_logistics_tracking_stream() {
  TENANT="orion-logistics"
  SERVICE="tracking-stream"
  OWNER="team:fulfillment"
  VERSION="4.22.3"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 14))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 14))"
}

fixture_016_orion_logistics_ops_dashboard() {
  TENANT="orion-logistics"
  SERVICE="ops-dashboard"
  OWNER="team:fulfillment"
  VERSION="5.25.10"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 15))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 15))"
}

fixture_017_cedar_media_content_api() {
  TENANT="cedar-media"
  SERVICE="content-api"
  OWNER="team:content"
  VERSION="2.28.17"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 16))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 16))"
}

fixture_018_cedar_media_recommendation_worker() {
  TENANT="cedar-media"
  SERVICE="recommendation-worker"
  OWNER="team:content"
  VERSION="3.31.5"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 17))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 17))"
}

fixture_019_cedar_media_transcode_orchestrator() {
  TENANT="cedar-media"
  SERVICE="transcode-orchestrator"
  OWNER="team:content"
  VERSION="4.34.12"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 18))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 18))"
}

fixture_020_cedar_media_studio_web() {
  TENANT="cedar-media"
  SERVICE="studio-web"
  OWNER="team:content"
  VERSION="5.37.0"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 19))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 19))"
}

fixture_021_aurora_energy_meter_ingest() {
  TENANT="aurora-energy"
  SERVICE="meter-ingest"
  OWNER="team:grid"
  VERSION="2.10.7"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 20))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 20))"
}

fixture_022_aurora_energy_billing_api() {
  TENANT="aurora-energy"
  SERVICE="billing-api"
  OWNER="team:grid"
  VERSION="3.13.14"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 21))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 21))"
}

fixture_023_aurora_energy_forecast_worker() {
  TENANT="aurora-energy"
  SERVICE="forecast-worker"
  OWNER="team:grid"
  VERSION="4.16.2"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 0))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 22))"
}

fixture_024_aurora_energy_grid_console() {
  TENANT="aurora-energy"
  SERVICE="grid-console"
  OWNER="team:grid"
  VERSION="5.19.9"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 1))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 23))"
}

fixture_025_summit_travel_booking_api() {
  TENANT="summit-travel"
  SERVICE="booking-api"
  OWNER="team:booking"
  VERSION="2.22.16"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 2))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 24))"
}

fixture_026_summit_travel_inventory_sync() {
  TENANT="summit-travel"
  SERVICE="inventory-sync"
  OWNER="team:booking"
  VERSION="3.25.4"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 3))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 25))"
}

fixture_027_summit_travel_fare_engine() {
  TENANT="summit-travel"
  SERVICE="fare-engine"
  OWNER="team:booking"
  VERSION="4.28.11"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 4))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 26))"
}

fixture_028_summit_travel_agent_portal() {
  TENANT="summit-travel"
  SERVICE="agent-portal"
  OWNER="team:booking"
  VERSION="5.31.18"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 5))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 27))"
}

fixture_029_harbor_cloud_identity_api() {
  TENANT="harbor-cloud"
  SERVICE="identity-api"
  OWNER="team:platform"
  VERSION="2.34.6"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 6))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 28))"
}

fixture_030_harbor_cloud_quota_controller() {
  TENANT="harbor-cloud"
  SERVICE="quota-controller"
  OWNER="team:platform"
  VERSION="3.37.13"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 7))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 29))"
}

fixture_031_harbor_cloud_usage_aggregator() {
  TENANT="harbor-cloud"
  SERVICE="usage-aggregator"
  OWNER="team:platform"
  VERSION="4.10.1"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 8))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 30))"
}

fixture_032_harbor_cloud_admin_console() {
  TENANT="harbor-cloud"
  SERVICE="admin-console"
  OWNER="team:platform"
  VERSION="5.13.8"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 9))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 31))"
}

fixture_033_willow_learning_course_api() {
  TENANT="willow-learning"
  SERVICE="course-api"
  OWNER="team:learning"
  VERSION="2.16.15"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 10))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 32))"
}

fixture_034_willow_learning_assessment_worker() {
  TENANT="willow-learning"
  SERVICE="assessment-worker"
  OWNER="team:learning"
  VERSION="3.19.3"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 11))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 33))"
}

fixture_035_willow_learning_progress_stream() {
  TENANT="willow-learning"
  SERVICE="progress-stream"
  OWNER="team:learning"
  VERSION="4.22.10"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 12))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 34))"
}

fixture_036_willow_learning_teacher_console() {
  TENANT="willow-learning"
  SERVICE="teacher-console"
  OWNER="team:learning"
  VERSION="5.25.17"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 13))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 35))"
}

fixture_037_ember_games_matchmaker_api() {
  TENANT="ember-games"
  SERVICE="matchmaker-api"
  OWNER="team:live-services"
  VERSION="2.28.5"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 14))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 36))"
}

fixture_038_ember_games_session_director() {
  TENANT="ember-games"
  SERVICE="session-director"
  OWNER="team:live-services"
  VERSION="3.31.12"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 15))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 37))"
}

fixture_039_ember_games_economy_worker() {
  TENANT="ember-games"
  SERVICE="economy-worker"
  OWNER="team:live-services"
  VERSION="4.34.0"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 16))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 38))"
}

fixture_040_ember_games_liveops_console() {
  TENANT="ember-games"
  SERVICE="liveops-console"
  OWNER="team:live-services"
  VERSION="5.37.7"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 17))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 39))"
}

fixture_041_lumen_security_policy_api() {
  TENANT="lumen-security"
  SERVICE="policy-api"
  OWNER="team:detection"
  VERSION="2.10.14"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 18))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 40))"
}

fixture_042_lumen_security_event_correlator() {
  TENANT="lumen-security"
  SERVICE="event-correlator"
  OWNER="team:detection"
  VERSION="3.13.2"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 19))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 41))"
}

fixture_043_lumen_security_sensor_gateway() {
  TENANT="lumen-security"
  SERVICE="sensor-gateway"
  OWNER="team:detection"
  VERSION="4.16.9"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 20))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 42))"
}

fixture_044_lumen_security_analyst_console() {
  TENANT="lumen-security"
  SERVICE="analyst-console"
  OWNER="team:detection"
  VERSION="5.19.16"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 21))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 43))"
}

fixture_045_meadow_foods_order_api() {
  TENANT="meadow-foods"
  SERVICE="order-api"
  OWNER="team:delivery"
  VERSION="2.22.4"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 0))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 44))"
}

fixture_046_meadow_foods_kitchen_dispatch() {
  TENANT="meadow-foods"
  SERVICE="kitchen-dispatch"
  OWNER="team:delivery"
  VERSION="3.25.11"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 1))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 45))"
}

fixture_047_meadow_foods_delivery_planner() {
  TENANT="meadow-foods"
  SERVICE="delivery-planner"
  OWNER="team:delivery"
  VERSION="4.28.18"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 2))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 46))"
}

fixture_048_meadow_foods_merchant_console() {
  TENANT="meadow-foods"
  SERVICE="merchant-console"
  OWNER="team:delivery"
  VERSION="5.31.6"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 3))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 47))"
}

fixture_049_vector_mobility_trip_api() {
  TENANT="vector-mobility"
  SERVICE="trip-api"
  OWNER="team:dispatch"
  VERSION="2.34.13"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 4))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 48))"
}

fixture_050_vector_mobility_dispatch_engine() {
  TENANT="vector-mobility"
  SERVICE="dispatch-engine"
  OWNER="team:dispatch"
  VERSION="3.37.1"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 5))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 49))"
}

fixture_051_vector_mobility_telemetry_stream() {
  TENANT="vector-mobility"
  SERVICE="telemetry-stream"
  OWNER="team:dispatch"
  VERSION="4.10.8"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 6))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 50))"
}

fixture_052_vector_mobility_fleet_console() {
  TENANT="vector-mobility"
  SERVICE="fleet-console"
  OWNER="team:dispatch"
  VERSION="5.13.15"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 7))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 51))"
}

fixture_053_quartz_insurance_policy_api() {
  TENANT="quartz-insurance"
  SERVICE="policy-api"
  OWNER="team:claims"
  VERSION="2.16.3"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 8))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 52))"
}

fixture_054_quartz_insurance_claims_orchestrator() {
  TENANT="quartz-insurance"
  SERVICE="claims-orchestrator"
  OWNER="team:claims"
  VERSION="3.19.10"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 9))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 53))"
}

fixture_055_quartz_insurance_risk_worker() {
  TENANT="quartz-insurance"
  SERVICE="risk-worker"
  OWNER="team:claims"
  VERSION="4.22.17"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 10))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 54))"
}

fixture_056_quartz_insurance_broker_portal() {
  TENANT="quartz-insurance"
  SERVICE="broker-portal"
  OWNER="team:claims"
  VERSION="5.25.5"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 11))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 55))"
}

fixture_057_ripple_commerce_cart_api() {
  TENANT="ripple-commerce"
  SERVICE="cart-api"
  OWNER="team:marketplace"
  VERSION="2.28.12"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 12))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 56))"
}

fixture_058_ripple_commerce_promotion_engine() {
  TENANT="ripple-commerce"
  SERVICE="promotion-engine"
  OWNER="team:marketplace"
  VERSION="3.31.0"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 13))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 1 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 57))"
}

fixture_059_ripple_commerce_fulfillment_worker() {
  TENANT="ripple-commerce"
  SERVICE="fulfillment-worker"
  OWNER="team:marketplace"
  VERSION="4.34.7"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 14))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 2 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 58))"
}

fixture_060_ripple_commerce_seller_console() {
  TENANT="ripple-commerce"
  SERVICE="seller-console"
  OWNER="team:marketplace"
  VERSION="5.37.14"
  ENVIRONMENT="production"
  REGION="ap-northeast-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 15))"
  CANARY_PERCENT="$((1 + 4))"
  SOAK_SECONDS="$((240 + 3 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 4 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 59))"
}

fixture_061_pine_analytics_query_api() {
  TENANT="pine-analytics"
  SERVICE="query-api"
  OWNER="team:data-platform"
  VERSION="2.10.2"
  ENVIRONMENT="production"
  REGION="us-east-1"
  STRATEGY="canary"
  RISK_TIER="medium"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 16))"
  CANARY_PERCENT="$((1 + 0))"
  SOAK_SECONDS="$((240 + 4 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 0 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 60))"
}

fixture_062_pine_analytics_ingest_worker() {
  TENANT="pine-analytics"
  SERVICE="ingest-worker"
  OWNER="team:data-platform"
  VERSION="3.13.9"
  ENVIRONMENT="staging"
  REGION="us-west-2"
  STRATEGY="linear"
  RISK_TIER="high"
  REQUIRED_APPROVALS="2"
  REPLICAS="$((3 + 17))"
  CANARY_PERCENT="$((1 + 1))"
  SOAK_SECONDS="$((240 + 5 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 1 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 61))"
}

fixture_063_pine_analytics_segment_builder() {
  TENANT="pine-analytics"
  SERVICE="segment-builder"
  OWNER="team:data-platform"
  VERSION="4.16.16"
  ENVIRONMENT="production"
  REGION="eu-west-1"
  STRATEGY="blue-green"
  RISK_TIER="low"
  REQUIRED_APPROVALS="1"
  REPLICAS="$((3 + 18))"
  CANARY_PERCENT="$((1 + 2))"
  SOAK_SECONDS="$((240 + 6 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 2 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 62))"
}

fixture_064_pine_analytics_workspace_web() {
  TENANT="pine-analytics"
  SERVICE="workspace-web"
  OWNER="team:data-platform"
  VERSION="5.19.4"
  ENVIRONMENT="production"
  REGION="ap-southeast-1"
  STRATEGY="feature-flag"
  RISK_TIER="critical"
  REQUIRED_APPROVALS="3"
  REPLICAS="$((3 + 19))"
  CANARY_PERCENT="$((1 + 3))"
  SOAK_SECONDS="$((240 + 0 * 60))"
  ERROR_BUDGET_FLOOR_BPS="$((2200 + 3 * 250))"
  CHANGE_TICKET="CHG-$((41001 + 63))"
}

list_fixtures() {
  printf 'id\ttenant\tservice\tenvironment\tstrategy\n'
  printf '%s\t%s\t%s\t%s\t%s\n' "001" "northwind-retail" "checkout-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "002" "northwind-retail" "catalog-api" "staging" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "003" "northwind-retail" "pricing-worker" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "004" "northwind-retail" "storefront-web" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "005" "atlas-banking" "ledger-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "006" "atlas-banking" "payments-gateway" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "007" "atlas-banking" "fraud-scorer" "staging" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "008" "atlas-banking" "customer-portal" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "009" "helios-health" "patient-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "010" "helios-health" "claims-worker" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "011" "helios-health" "scheduling-api" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "012" "helios-health" "care-console" "staging" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "013" "orion-logistics" "routing-engine" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "014" "orion-logistics" "shipment-api" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "015" "orion-logistics" "tracking-stream" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "016" "orion-logistics" "ops-dashboard" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "017" "cedar-media" "content-api" "staging" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "018" "cedar-media" "recommendation-worker" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "019" "cedar-media" "transcode-orchestrator" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "020" "cedar-media" "studio-web" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "021" "aurora-energy" "meter-ingest" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "022" "aurora-energy" "billing-api" "staging" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "023" "aurora-energy" "forecast-worker" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "024" "aurora-energy" "grid-console" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "025" "summit-travel" "booking-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "026" "summit-travel" "inventory-sync" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "027" "summit-travel" "fare-engine" "staging" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "028" "summit-travel" "agent-portal" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "029" "harbor-cloud" "identity-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "030" "harbor-cloud" "quota-controller" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "031" "harbor-cloud" "usage-aggregator" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "032" "harbor-cloud" "admin-console" "staging" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "033" "willow-learning" "course-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "034" "willow-learning" "assessment-worker" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "035" "willow-learning" "progress-stream" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "036" "willow-learning" "teacher-console" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "037" "ember-games" "matchmaker-api" "staging" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "038" "ember-games" "session-director" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "039" "ember-games" "economy-worker" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "040" "ember-games" "liveops-console" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "041" "lumen-security" "policy-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "042" "lumen-security" "event-correlator" "staging" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "043" "lumen-security" "sensor-gateway" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "044" "lumen-security" "analyst-console" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "045" "meadow-foods" "order-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "046" "meadow-foods" "kitchen-dispatch" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "047" "meadow-foods" "delivery-planner" "staging" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "048" "meadow-foods" "merchant-console" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "049" "vector-mobility" "trip-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "050" "vector-mobility" "dispatch-engine" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "051" "vector-mobility" "telemetry-stream" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "052" "vector-mobility" "fleet-console" "staging" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "053" "quartz-insurance" "policy-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "054" "quartz-insurance" "claims-orchestrator" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "055" "quartz-insurance" "risk-worker" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "056" "quartz-insurance" "broker-portal" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "057" "ripple-commerce" "cart-api" "staging" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "058" "ripple-commerce" "promotion-engine" "production" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "059" "ripple-commerce" "fulfillment-worker" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "060" "ripple-commerce" "seller-console" "production" "feature-flag"
  printf '%s\t%s\t%s\t%s\t%s\n' "061" "pine-analytics" "query-api" "production" "canary"
  printf '%s\t%s\t%s\t%s\t%s\n' "062" "pine-analytics" "ingest-worker" "staging" "linear"
  printf '%s\t%s\t%s\t%s\t%s\n' "063" "pine-analytics" "segment-builder" "production" "blue-green"
  printf '%s\t%s\t%s\t%s\t%s\n' "064" "pine-analytics" "workspace-web" "production" "feature-flag"

}

load_fixture() {
  local requested="$1"
  case "${requested}" in
    "001"|"northwind-retail/checkout-api") fixture_001_northwind_retail_checkout_api ;;
    "002"|"northwind-retail/catalog-api") fixture_002_northwind_retail_catalog_api ;;
    "003"|"northwind-retail/pricing-worker") fixture_003_northwind_retail_pricing_worker ;;
    "004"|"northwind-retail/storefront-web") fixture_004_northwind_retail_storefront_web ;;
    "005"|"atlas-banking/ledger-api") fixture_005_atlas_banking_ledger_api ;;
    "006"|"atlas-banking/payments-gateway") fixture_006_atlas_banking_payments_gateway ;;
    "007"|"atlas-banking/fraud-scorer") fixture_007_atlas_banking_fraud_scorer ;;
    "008"|"atlas-banking/customer-portal") fixture_008_atlas_banking_customer_portal ;;
    "009"|"helios-health/patient-api") fixture_009_helios_health_patient_api ;;
    "010"|"helios-health/claims-worker") fixture_010_helios_health_claims_worker ;;
    "011"|"helios-health/scheduling-api") fixture_011_helios_health_scheduling_api ;;
    "012"|"helios-health/care-console") fixture_012_helios_health_care_console ;;
    "013"|"orion-logistics/routing-engine") fixture_013_orion_logistics_routing_engine ;;
    "014"|"orion-logistics/shipment-api") fixture_014_orion_logistics_shipment_api ;;
    "015"|"orion-logistics/tracking-stream") fixture_015_orion_logistics_tracking_stream ;;
    "016"|"orion-logistics/ops-dashboard") fixture_016_orion_logistics_ops_dashboard ;;
    "017"|"cedar-media/content-api") fixture_017_cedar_media_content_api ;;
    "018"|"cedar-media/recommendation-worker") fixture_018_cedar_media_recommendation_worker ;;
    "019"|"cedar-media/transcode-orchestrator") fixture_019_cedar_media_transcode_orchestrator ;;
    "020"|"cedar-media/studio-web") fixture_020_cedar_media_studio_web ;;
    "021"|"aurora-energy/meter-ingest") fixture_021_aurora_energy_meter_ingest ;;
    "022"|"aurora-energy/billing-api") fixture_022_aurora_energy_billing_api ;;
    "023"|"aurora-energy/forecast-worker") fixture_023_aurora_energy_forecast_worker ;;
    "024"|"aurora-energy/grid-console") fixture_024_aurora_energy_grid_console ;;
    "025"|"summit-travel/booking-api") fixture_025_summit_travel_booking_api ;;
    "026"|"summit-travel/inventory-sync") fixture_026_summit_travel_inventory_sync ;;
    "027"|"summit-travel/fare-engine") fixture_027_summit_travel_fare_engine ;;
    "028"|"summit-travel/agent-portal") fixture_028_summit_travel_agent_portal ;;
    "029"|"harbor-cloud/identity-api") fixture_029_harbor_cloud_identity_api ;;
    "030"|"harbor-cloud/quota-controller") fixture_030_harbor_cloud_quota_controller ;;
    "031"|"harbor-cloud/usage-aggregator") fixture_031_harbor_cloud_usage_aggregator ;;
    "032"|"harbor-cloud/admin-console") fixture_032_harbor_cloud_admin_console ;;
    "033"|"willow-learning/course-api") fixture_033_willow_learning_course_api ;;
    "034"|"willow-learning/assessment-worker") fixture_034_willow_learning_assessment_worker ;;
    "035"|"willow-learning/progress-stream") fixture_035_willow_learning_progress_stream ;;
    "036"|"willow-learning/teacher-console") fixture_036_willow_learning_teacher_console ;;
    "037"|"ember-games/matchmaker-api") fixture_037_ember_games_matchmaker_api ;;
    "038"|"ember-games/session-director") fixture_038_ember_games_session_director ;;
    "039"|"ember-games/economy-worker") fixture_039_ember_games_economy_worker ;;
    "040"|"ember-games/liveops-console") fixture_040_ember_games_liveops_console ;;
    "041"|"lumen-security/policy-api") fixture_041_lumen_security_policy_api ;;
    "042"|"lumen-security/event-correlator") fixture_042_lumen_security_event_correlator ;;
    "043"|"lumen-security/sensor-gateway") fixture_043_lumen_security_sensor_gateway ;;
    "044"|"lumen-security/analyst-console") fixture_044_lumen_security_analyst_console ;;
    "045"|"meadow-foods/order-api") fixture_045_meadow_foods_order_api ;;
    "046"|"meadow-foods/kitchen-dispatch") fixture_046_meadow_foods_kitchen_dispatch ;;
    "047"|"meadow-foods/delivery-planner") fixture_047_meadow_foods_delivery_planner ;;
    "048"|"meadow-foods/merchant-console") fixture_048_meadow_foods_merchant_console ;;
    "049"|"vector-mobility/trip-api") fixture_049_vector_mobility_trip_api ;;
    "050"|"vector-mobility/dispatch-engine") fixture_050_vector_mobility_dispatch_engine ;;
    "051"|"vector-mobility/telemetry-stream") fixture_051_vector_mobility_telemetry_stream ;;
    "052"|"vector-mobility/fleet-console") fixture_052_vector_mobility_fleet_console ;;
    "053"|"quartz-insurance/policy-api") fixture_053_quartz_insurance_policy_api ;;
    "054"|"quartz-insurance/claims-orchestrator") fixture_054_quartz_insurance_claims_orchestrator ;;
    "055"|"quartz-insurance/risk-worker") fixture_055_quartz_insurance_risk_worker ;;
    "056"|"quartz-insurance/broker-portal") fixture_056_quartz_insurance_broker_portal ;;
    "057"|"ripple-commerce/cart-api") fixture_057_ripple_commerce_cart_api ;;
    "058"|"ripple-commerce/promotion-engine") fixture_058_ripple_commerce_promotion_engine ;;
    "059"|"ripple-commerce/fulfillment-worker") fixture_059_ripple_commerce_fulfillment_worker ;;
    "060"|"ripple-commerce/seller-console") fixture_060_ripple_commerce_seller_console ;;
    "061"|"pine-analytics/query-api") fixture_061_pine_analytics_query_api ;;
    "062"|"pine-analytics/ingest-worker") fixture_062_pine_analytics_ingest_worker ;;
    "063"|"pine-analytics/segment-builder") fixture_063_pine_analytics_segment_builder ;;
    "064"|"pine-analytics/workspace-web") fixture_064_pine_analytics_workspace_web ;;

    *) die "unknown fixture: ${requested}" ;;
  esac
  FIXTURE_ID="${requested}"
}

main() {
  parse_arguments "$@"
  if [ -n "${FIXTURE_ID}" ]; then
    load_fixture "${FIXTURE_ID}"
  fi
  case "${COMMAND}" in
    fixtures)
      if [ -n "${FIXTURE_ID}" ]; then
        validate_inputs
        print_plan
      else
        list_fixtures
      fi
      ;;
    self-test)
      self_test
      ;;
    plan)
      validate_inputs
      print_plan
      ;;
    release)
      validate_inputs
      execute_release
      ;;
    rollback)
      execute_rollback
      ;;
    diagnose)
      diagnose
      ;;
  esac
}

main "$@"
