import {nativeEgressInstallCommands} from "./onboard-runner-egress.js";
import { GITHUB_CONFIRM_ACCESS } from "./onboard-github-copy.js";
import { INSTALL_COMMAND, loadConfig, normalizeBaseUrl } from "./config.js";
import type { OnboardJournal, OnboardStep } from "./onboard.js";
import { githubInstallationPage } from "./onboard-permissions.js";
import { valuesFacts, valuesFix } from "./ready-copy.js";
import { DEFAULT_HOST_FREE_FLOOR_GIB, isRunnerDiskUnmeasured, runnerDiskCopy } from "./onboard-runner-disk.js";

/** What a person reads for a step that is not done. Each line ends in an action they can take. */
const REASONS: Record<string, string> = {
  legacy_cleanup_failed:
    "An earlier Catalyst installation could not be removed. Run catalyst legacy --remove to see the exact item and its blocker, fix that blocker, then run catalyst setup again. Shared data folders are kept.",
  account_identity_unverified:
    "Your login changed while AI accounts were checked. Run catalyst onboard again to verify your person and workspace.",
  account_inventory_unavailable:
    "AI accounts could not be read. Run catalyst onboard again to retry.",
  account_inventory_unverified:
    "The server did not return a fresh supported AI account list. Run catalyst onboard after the server update.",
  connect_checklist_refused:
    "Catalyst refused to show this login the Connect accounts page's status. Sign in again with catalyst login, then run catalyst onboard.",
  connect_checklist_identity_unverified:
    "Your login changed while setup was checking the Connect accounts page. Run catalyst onboard again to verify your person and workspace.",
  coding_account_inactive:
    "The AI account named by --coding-account is turned off. Turn it on in the workspace's AI account settings, then run catalyst onboard.",
  coding_account_ended:
    "The AI account named by --coding-account was removed or its access has ended. Name another one with --coding-account, or add one in the workspace's AI account settings.",
  coding_account_needs_login:
    "The AI account named by --coding-account needs its key added again. Replace it in the workspace's AI account settings, then run catalyst onboard.",
  coding_account_quarantined:
    "The AI account named by --coding-account is held after repeated failures. Check it in the workspace's AI account settings, then run catalyst onboard.",
  coding_account_walled:
    "The AI account named by --coding-account has used its usage limit for now. Check when it resets, then run catalyst onboard again.",
  coding_account_not_found:
    "The AI account named by --coding-account is not in this workspace. Run catalyst accounts to list the slots, then run catalyst onboard with one of them.",
  account_validation_admin_required:
    "An administrator must check the workspace's AI account access.",
  account_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard.",
  account_validation_unavailable:
    "The provider check could not finish. Run catalyst onboard again to retry.",
  account_validation_unverified:
    "The server did not return a fresh provider check. Run catalyst onboard after the server update.",
  account_provider_access_unverified:
    "AI account access is not freshly verified. Check the account in the workspace's AI account settings, then resume setup.",
  codex_provider_access_unverified:
    "Codex credentials are stored, but provider access is not freshly verified. Setup did not refresh or rotate the Codex login.",
  account_provider_walled:
    "Claude's usage limit is spent for now. Check the account's reset time, then run catalyst onboard again.",
  account_provider_rejected:
    "Claude refused the stored login. Replace it in the workspace's AI account settings, then resume setup.",
  personal_consent_handoff:
    "The browser approval link could not be verified. Run catalyst onboard to try again.",
  personal_identity_refused:
    "Your current login no longer matches this setup. Resume with the original workspace and person.",
  personal_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  onboard_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  personal_status_unavailable:
    "Your personal connection could not be checked. Run catalyst onboard to try again.",
  workspace_browser_unavailable:
    "The link to connect Linear timed out. Run catalyst setup for a new one.",
  personal_browser_unavailable:
    "The link to connect your own account timed out. Run catalyst setup for a new one.",
  onboarding_capability_unavailable:
    "The server's setup capabilities could not be checked. Run catalyst onboard to try again.",
  onboarding_capability_identity_unverified:
    "The server's setup capabilities belong to another login or workspace. Sign in to the original workspace to resume.",
  onboarding_capability_login_refresh_required:
    "Your login needs a refresh before setup capabilities can be checked. Run catalyst login, then catalyst onboard.",
  workspace_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  workspace_consent_refused:
    "The server did not accept this login for Linear workspace setup. Sign in again or ask your workspace administrator.",
  github_installation_status_unavailable:
    "Your GitHub App installation could not be checked. Run catalyst onboard to try again.",
  github_installation_status_shape:
    "The server returned a GitHub installation result that could not be verified.",
  github_installation_consent_handoff:
    "The GitHub installation approval link could not be verified. Run catalyst onboard to try again.",
  github_installation_consent_refused:
    "The server did not accept this login for GitHub App setup. Sign in again or ask your workspace administrator.",
  github_installation_identity_refused:
    "GitHub setup belongs to another login or workspace. Sign in to the original workspace to resume.",
  github_installation_admin_required:
    "A workspace owner or administrator approves the GitHub App installation.",
  github_installation_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  github_installation_browser_unavailable:
    "The link to install Catalyst on GitHub timed out. Run catalyst setup for a new one.",
  github_installation_approval_pending:
    "An install request is waiting on GitHub. An owner of your GitHub organization approves it there, then run catalyst setup.",
  github_install_pending:
    "Runs after Catalyst is installed on GitHub.",
  consent_timeout: "The link timed out. Run catalyst setup for a new one.",
  skills_install_unverified:
    "The Catalyst skills are not in this user's skills folder. Run catalyst install, then run catalyst onboard.",
  step_not_available_in_this_release:
    "This setup step is not available yet.",
  prerequisite_not_ready: "Waiting for an earlier setup step.",
  local_sync_not_selected: "Using cloud reads. Local sync was not selected.",
  local_sync_capability_unavailable:
    "Local sync was selected but could not be verified.",
  member_scope: "Your workspace administrator handles this step.",
  returning_workspace_move_on: "Existing projects were left in place while this computer was set up. Run catalyst ready to review their checks, or catalyst setup --team <TEAM KEY> to repair one.",
  returning_inventory_unverified: "Setup could not verify this workspace's existing projects. Run catalyst ready to check the workspace, then run catalyst setup again. Its projects have been kept in place.",
  returning_project_cleanup_requested: "Review the selected project's archive preview before making any change.",
  returning_project_cleanup_unverified: "Setup could not confirm this project's archive state. Run catalyst project list to inspect it, then run catalyst setup again to review any remaining changes. Do not repeat an archive based on this message alone.",
  returning_project_cleanup_changed: "This project's repositories changed after the preview. Run catalyst setup again to review its current project list before archiving.",
  member_team_required:
    "Setup needs your Linear team to check what Catalyst can work on. Run catalyst setup again with --team <KEY>, using your team's key from Linear.",
  onboarding_checks_pending: "Some required checks are still unverified.",
  interrupted: "Setup paused. Run the same command to resume.",
  signin_timeout: "Sign-in timed out. Run catalyst onboard to try again.",
  linear_workspace_unverified:
    "Your Linear workspace connection could not be verified.",
  team_inventory_empty: "No existing Linear teams could be verified.",
  team_inventory_shape:
    "The cloud returned a team list that could not be verified.",
  team_read_unavailable:
    "Your existing Linear teams could not be read. Run catalyst onboard to try again.",
  team_read_identity_unverified:
    "Your login changed while setup was reading this workspace. Resume with the original workspace and person.",
  project_identity_unverified:
    "Your login changed while setup was checking this project. Resume with the original workspace and person.",
  project_options_unavailable:
    "Available teams and repositories could not be checked. Run catalyst onboard to try again.",
  project_provider_inventory_unavailable:
    "Linear or GitHub access could not be verified. Check this workspace's connections, then resume.",
  project_options_unverified:
    "The server returned a team or repository list that could not be verified.",
  project_registration_visibility_pending:
    "Your project exists, but its repository binding is not visible yet. Run catalyst onboard to check again.",
  project_binding_conflict:
    "This team or repository is already bound to a project. Ask your workspace administrator to check its binding, then resume.",
  project_login_refresh_required:
    "Renew your login with catalyst onboard, then review the plan before creating this project.",
  project_create_unverified:
    "Project creation could not be confirmed. Run catalyst onboard to check for the project before trying again.",
  team_read_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard to resume.",
  team_create_unavailable:
    "The Linear team could not be created, and nothing was created. Run catalyst onboard to try again, or create the team in Linear and pick it.",
  team_create_unverified:
    "Setup could not confirm whether the Linear team was created. Check Linear for it before creating it again.",
  team_create_grant_required:
    "Your own Linear connection is missing or has lapsed. Reconnect it with catalyst connections personal linear start and approve the link it prints, then run catalyst onboard. Nothing was created.",
  team_create_identity_unverified:
    "Your login changed while setup was creating a team. Resume with the original workspace and person.",
  team_choice_required:
    "Choose an existing team with catalyst onboard --team <team ID or key>.",
  team_selection_unverified:
    "Your selected Linear team could not be verified. Run catalyst onboard --team <team ID or key> to choose again.",
  repository_choice_required:
    "Choose repositories with catalyst onboard --repo <owner/name>. Repeat --repo to choose more than one.",
  repository_inventory_empty:
    "No accessible repositories are registered to this Linear team yet.",
  repository_read_unavailable:
    "Your repository list could not be read. Run catalyst onboard to try again.",
  repository_inventory_shape:
    "The cloud returned a repository list that could not be verified.",
  repository_contract_unavailable:
    "Current repository IDs could not be checked. Run catalyst onboard to try again.",
  repository_contract_unverified:
    "The cloud returned repository IDs that could not be verified for this workspace.",
  repository_id_unverified:
    "A repository's current ID could not be verified. Keep your selection and try again.",
  repository_binding_ambiguous:
    "A repository's Linear team binding is ambiguous. Your administrator needs to check it.",
  repository_identity_unverified:
    "Sign in to the original workspace to choose repositories.",
  settings_review_timeout:
    "The settings review timed out. Run catalyst onboard to resume.",
  settings_checkout_unverified:
    "Setup could not verify the repository's local checkout or settings file. Settings are optional for a first ticket. To finish them later, run catalyst onboard from the repository's checkout.",
  settings_draft_storage_unavailable:
    "A private settings draft could not be kept. Run catalyst onboard to retry.",
  settings_draft_storage_timeout:
    "Keeping your settings draft took too long. Run catalyst onboard to retry.",
  settings_approval_unverified:
    "Settings still need review and approval; kept drafts do not count. Settings are optional for a first ticket. To finish them later, run catalyst onboard from the repository's checkout.",
  repository_selection_unverified:
    "Your selected repositories could not be verified. Run catalyst onboard --repo <owner/name> to choose again.",
  workflow_adoption_declined:
    "Skipped for now. Run catalyst onboard to review the changes again.",
  workflow_identity_unverified:
    "Setup could not confirm the signed-in workspace, person or role for this team. Run catalyst onboard again as a workspace owner or administrator.",
  workflow_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard.",
  workflow_mapping_changed:
    "The team's workflow changed while setup checked it. Run catalyst onboard again.",
  workflow_admin_required:
    "Applying the Catalyst workflow needs a workspace owner or administrator. Ask one to run catalyst onboard for this team.",
  workflow_plan_changed:
    "The team's Linear workflow changed while setup was applying it. Run catalyst onboard again to see the new plan.",
  verification_pending:
    "Setup made the change but could not confirm it yet. Run catalyst onboard again to check.",
  automations_compatible: "Nothing to change.",
  workflow_unavailable:
    "Setup could not read the team's workflow. Run catalyst onboard again to retry.",
  capacity_context_unverified:
    "Setup could not confirm this project's registered repositories and its default repository for capacity. Run catalyst ready to see the project checks, then run catalyst setup again. Starting a ticket checks its own repository's admission.",
  capacity_identity_unverified:
    "Setup could not confirm your workspace and administrator role for the capacity check. Run catalyst login, then run catalyst setup again.",
  capacity_admission_unverified:
    "No runner is allowed to take work for this workspace yet. Enroll a self-hosted runner host, or ask Catalyst to enable cloud runners for it. Then run catalyst onboard.",
  capacity_currently_full:
    "Every runner slot for this repository is in use. Run catalyst onboard again after current work finishes.",
  capacity_unavailable:
    "Setup could not read runner capacity. Run catalyst onboard again to retry.",
  runner_not_selected:
    "This setup does not start a runner on this machine. To start one, run catalyst onboard --runner.",
  runner_docker_missing:
    "A runner needs Docker with Compose (Docker Desktop, OrbStack or Docker Engine), and setup could not reach it. Start Docker, or install it, then run catalyst onboard --runner.",
  runner_identity_unverified:
    "A workspace owner or administrator enrolls a runner. Sign in as one with catalyst login, then run catalyst onboard --runner.",
  runner_context_unverified:
    "Setup could not confirm a project for this machine. Keep its existing installation and credentials. Run catalyst setup --runner --team <TEAM KEY> for the project this machine should serve.",
  runner_directory_unavailable:
    "Setup could not prepare the runner folder in Catalyst's state directory. Check its permissions, then run catalyst onboard again.",
  runner_image_unpinned:
    "Each runner image must be pinned as name@sha256:<digest>, and Catalyst's runner image is not public yet. Ask Catalyst support to load it here and set CATALYST_RUNNER_IMAGE to the reference they give you. A CATALYST_SUPERVISOR_IMAGE or CATALYST_WATCHDOG_IMAGE override takes the same form. Then run catalyst onboard --runner.",
  runner_image_emulated:
    "A runner image here is built for another processor, and Catalyst does not run work under emulation. Ask Catalyst support for the image built for this processor, then run catalyst onboard again.",
  runner_session_network_misshaped:
    "A Docker network named catalyst-session-v1 exists with the wrong settings. Remove it with docker network rm catalyst-session-v1 when nothing uses it, then run catalyst onboard again.",
  runner_session_network_failed:
    "Docker could not create the catalyst-session-v1 network. Check that Docker is running, then run catalyst onboard again.",
  runner_docker_socket_unreadable:
    "Setup could not read the group of the Docker socket at /var/run/docker.sock. Check that Docker is running, then run catalyst onboard again.",
  runner_engine_unsupported:
    "Runner setup needs a local Linux Docker engine with Compose on Mac, or native Linux Docker at /var/run/docker.sock. Select a local engine, then run catalyst onboard --runner.",
  runner_engine_nonlocal:
    "The selected Docker endpoint is not a verified local unix:/// socket, or DOCKER_CONTEXT conflicts with DOCKER_HOST. Select a local Docker context and clear the conflicting variable, then run catalyst onboard --runner.",
  runner_home_mount_unwritable:
    "A container could not read and write the runner home mounts as uid 10001. Share Catalyst's state directory with your Docker VM and enable writable mounts. For Colima, configure a writable home mount with ownership mapping for uid 10001, then restart the VM and run catalyst onboard --runner.",
  runner_container_host_unreachable:
    "A container could not reach this Mac. Enable container-to-host networking in your Docker VM and allow the setup process through the Mac firewall, then run catalyst onboard --runner.",
  runner_container_network_unreachable:
    "A container could not reach Catalyst's health endpoint. Check the Docker VM's DNS, proxy and outbound HTTPS access, then run catalyst onboard --runner.",
  runner_engine_probe_unavailable:
    "Setup could not complete the container capability probe. Check Docker access and the pinned supervisor image, then run catalyst onboard --runner. Setup has not enrolled or started this machine.",
  runner_thoughts_custody_unavailable:
    "Setup could not verify protected access to this Mac's shared work files. Keep their ownership and permissions. Check Docker access, then run catalyst onboard --runner. If the check still fails, ask Catalyst support to inspect it.",
  runner_installation_unverified:
    "Setup found a possible existing machine installation but could not verify its Compose files and identity. Keep its files and credentials. Run docker compose -p catalyst-host logs supervisor to check it, then run catalyst setup --runner again.",
  runner_enrollment_unavailable:
    "Setup could not read this workspace's runner hosts. Run catalyst onboard again to retry.",
  runner_enrolled_for_other_team:
    "This runner is enrolled for another Linear team. Keep using that team, or ask your administrator to revoke the old enrollment before setting up this machine for the selected team.",
  runner_enrollment_revoked:
    "Catalyst confirms that this machine's saved enrollment was revoked. Keep its credential and organization key. Ask your workspace administrator to review the enrollment before replacing it, then run catalyst setup --runner.",
  runner_credential_unverified:
    "Setup could not read this machine's saved enrollment. Keep its credential and organization key. Run docker compose -p catalyst-host logs supervisor to check the error, then run catalyst setup --runner.",
  runner_enrollment_stale:
    "Setup could not match this machine's saved enrollment with Catalyst. Keep its credential and organization key, then run catalyst setup --runner to check again.",
  runner_login_refresh_required:
    "Renew your login with catalyst login, then run catalyst onboard.",
  runner_join_token_unavailable:
    "Catalyst did not issue a join token for this machine. Run catalyst onboard again to retry.",
  runner_session_network_unavailable:
    "Docker could not inspect the runner session network. Check engine access and run the same setup command again. Setup has not created a replacement network.",
  runner_capability_unavailable:
    "Catalyst could not read runner setup support. Run the same setup command again.",
  runner_capability_unverified:
    "Catalyst returned runner setup information this CLI cannot verify. Ask Catalyst support to check the server contract, then run the same setup command.",
  runner_org_key_journal_unavailable:
    "Setup cannot safely use its saved runner credential request. Keep the request file and ask Catalyst support to inspect it.",
  runner_org_key_recovery_required:
    "The previous runner key request may already have issued a key. Ask your workspace administrator to revoke that saved request and explicitly restart it. Setup will not mint another key automatically.",
  runner_org_key_reconciliation_pending:
    "The previous runner key request is still uncertain. Run the same setup command to check its saved request again.",
  runner_org_key_response_unverified:
    "Setup could not verify the runner key's tenant and scopes. Ask your workspace administrator to inspect the saved request.",
  runner_cloud_unavailable:
    "Catalyst did not complete the runner setup request. Run the same setup command to check its saved request before continuing.",
  runner_admission_disabled:
    "The selected team does not admit runner work. Run the same setup command with runner selection to explicitly enable its restricted admission policy.",
  runner_org_key_file_invalid:
    "CATALYST_RUNNER_ORG_KEY_FILE must name a regular file that holds one organization key. Fix the file, then run catalyst onboard again.",
  runner_org_key_invalid:
    "The runner account key is invalid, belongs to another workspace, or lacks mirror read, write and feed permissions. Supply a scoped key for this workspace with CATALYST_RUNNER_ORG_KEY_FILE, then run catalyst onboard --runner.",
  runner_org_key_unavailable:
    "The runner account key could not be checked with Catalyst. Run catalyst onboard --runner to retry.",
  runner_org_key_write_failed:
    "Setup could not place the organization key on the runner. Check that Docker is running, then run catalyst onboard again.",
  runner_compose_failed:
    "Docker Compose could not start the runner project catalyst-host. Run docker compose -p catalyst-host logs to see why, then run catalyst onboard --runner again.",
  runner_compose_paused:
    "The existing catalyst-host Compose project's containers are paused. Run docker compose -p catalyst-host unpause to resume them, then run catalyst onboard --runner again. Setup removed nothing.",
  runner_compose_not_running:
    "The runner's supervisor is not running. Run docker compose -p catalyst-host logs supervisor to see why, then run catalyst onboard again.",
  runner_enrollment_unverified:
    "The runner started but has not enrolled yet. Run docker compose -p catalyst-host logs supervisor to see why, or run catalyst onboard again in a minute.",
  runner_needs_runner_flag:
    "This machine was set up to run Catalyst's work, but its runner is not running or not enrolled. To bring it up, run catalyst onboard --runner.",
  runner_host_disk_sampler_python_missing:
    "Setup needs Python 3 to measure this Mac's disk for the runner. Install Apple's Command Line Tools with xcode-select --install, or python3 from Homebrew, then run catalyst setup --runner.",
  runner_host_disk_location_unverified:
    "Setup could not tell which disk holds your Docker engine's virtual machine, so it cannot measure this Mac's free space for the runner. Set CATALYST_HOST_DISK_PATH to that folder (for a relocated Docker Desktop disk image, the folder chosen in Settings, Resources, Advanced), then run catalyst setup --runner.",
  runner_host_disk_sampler_failed:
    "Setup could not start the dev.catalystcloud.host-disk LaunchAgent that measures this Mac's disk, so the runner will advertise zero free slots. Run launchctl print gui/$(id -u)/dev.catalystcloud.host-disk, or user/$(id -u)/dev.catalystcloud.host-disk when no one is logged in at the console, to see why, then run catalyst setup --runner.",
  runner_host_disk_sampler_not_repeating:
    "Setup loaded the dev.catalystcloud.host-disk LaunchAgent, but launchd did not keep it measuring this Mac's disk: it published no new sample within 25 seconds, so the runner will advertise zero free slots. launchd can hold back an agent loaded from an SSH session. Log in to this Mac's desktop, at the console or over Screen Sharing, and run catalyst setup --runner in Terminal there. To see what launchd did, run launchctl print gui/$(id -u)/dev.catalystcloud.host-disk and read its runs and pended lines.",
  runner_capability_pending:
    "The runner enrolled but has not reported its capacity yet. Run catalyst onboard again in a minute.",
  runner_admission_unverified:
    "Setup could not read whether the team's pool admits runner hosts. Run catalyst onboard again to retry.",
  github_app_permissions_outdated:
    `The existing GitHub App installation needs updated permissions accepted. ${GITHUB_CONFIRM_ACCESS} An organization owner on GitHub opens the App's installation page, chooses Review permissions, then Accept new permissions. Run catalyst onboard afterward.`,
  github_app_repository_missing:
    "The GitHub App installation cannot reach a repository a project registers. An organization owner on GitHub adds it under the installation's Repository access, then run catalyst onboard.",
  github_app_repository_not_installed:
    "No GitHub App installation can reach a repository a project registers. A workspace owner or administrator installs the GitHub App on its owner: run catalyst onboard.",
  github_app_permissions_unverified:
    "The GitHub App installation works, but its granted permissions could not be checked. Run catalyst onboard to try again.",
  github_app_repository_access_unverified:
    "Whether the GitHub App reaches every registered repository could not be checked. Run catalyst onboard to try again.",
  linear_workspace_scope_outdated:
    "The workspace's Linear connection (the Catalyst app) is missing scopes this version needs. A workspace owner or administrator re-authorizes it from the workspace's Integrations page, then run catalyst onboard.",
  linear_workspace_permissions_unverified:
    "The workspace's Linear connection works, but its granted scopes could not be checked. Run catalyst onboard to try again.",
  linear_personal_scope_outdated:
    "Your personal Linear connection is missing scopes this version needs. Re-authorize it from Connected accounts, then run catalyst onboard.",
  personal_permissions_unverified:
    "Your personal connection's granted scopes could not be checked. Run catalyst onboard to try again.",
  required_values_unverified:
    "Setup couldn't get a current readiness check for this team from Catalyst, so it can't tell whether the repositories' values are set. Run catalyst ready to check.",
  first_ticket_team_unverified:
    "Setup could not confirm the selected Linear team. Run catalyst setup again.",
  first_ticket_dispatch_unmapped:
    "Catalyst does not know which of the team's stages starts its work yet. Set up the team's Catalyst workflow, then run catalyst setup again.",
  housekeeping_service_unverified:
    "The daily update needs a user service manager, launchd on macOS or systemd --user on Linux. Setup cannot schedule it on this computer. It is optional, and work does not depend on it.",
  housekeeping_off_chosen:
    "The daily update is off, as you chose when you installed. It is optional. catalyst says when an update is out.",
  housekeeping_no_scheduler:
    "The daily update can't run on this computer: it needs launchd on macOS or systemd --user on Linux. It is optional. catalyst says when an update is out.",
  housekeeping_not_loaded:
    "The daily update is installed but not turned on. Run launchctl load ~/Library/LaunchAgents/dev.catalystcloud.housekeeping.plist to turn it on.",
  housekeeping_not_enabled:
    "The daily update is installed but not turned on. Run systemctl --user enable --now catalyst-housekeeping.timer to turn it on.",
  housekeeping_not_scheduled: `The daily update is not scheduled on this computer. Run the installer again to schedule it: ${INSTALL_COMMAND} -s -- --housekeeping yes`,
};

/** The saved login's web address, or nothing when the config is missing, unreadable or not http(s). */
export function savedOnboardBaseUrl(home: string): string | undefined {
  try {
    const cfg = loadConfig(home);
    const url = cfg ? webUrl(cfg.baseUrl) : undefined;
    return url ? normalizeBaseUrl(url) : undefined;
  } catch {
    return undefined;
  }
}
// Receipt and config text reaches the terminal only after URL parsing has escaped it.
function webUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** The selected team's key from the receipt, only when it is plain enough to print in a command. */
export function onboardTeamKey(journal?: OnboardJournal): string | undefined {
  const step = journal?.steps.find((row) => row.id === "linear.team");
  const key = step?.state === "done" ? step.evidence?.teamKey : undefined;
  return typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)
    ? key
    : undefined;
}

/** Receipt evidence printed inside a sentence: names, scopes and permission labels only. */
function evidenceText(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z0-9 ._:;/(),-]{1,2000}$/.test(value)
    ? value
    : undefined;
}

const LINEAR_START: Record<string, string> = {
  linear_workspace_scope_outdated: "/settings/connections",
  linear_personal_scope_outdated: "/connect/linear/personal/start",
};

/** A receipt URL, printed only when it is the page this reason's action lives on: the exact
 * installation's page on github.com, or this cloud's own OAuth start for the grant in question. */
function actionUrl(step: OnboardStep, baseUrl?: string): string | undefined {
  const href = webUrl(step.evidence?.url);
  if (!href) return undefined;
  const url = new URL(href);
  if (
    url.protocol !== "https:" ||
    url.hash ||
    (url.search &&
      !(
        step.reason === "linear_workspace_scope_outdated" &&
        url.pathname === "/settings/connections" &&
        url.search === "?reauthorize=linear"
      ))
  )
    return undefined;
  const evidence = step.evidence ?? {};
  if (
    step.reason === "github_app_permissions_outdated" ||
    step.reason === "github_app_repository_missing"
  )
    return githubInstallationPage(
      url,
      typeof evidence.installation === "string" ? evidence.installation : "",
      typeof evidence.org === "string" ? evidence.org : null,
      step.reason === "github_app_permissions_outdated",
    )
      ? href
      : undefined;
  const base = baseUrl ? webUrl(baseUrl) : undefined;
  return base &&
    new URL(base).origin === url.origin &&
    url.pathname === LINEAR_START[step.reason ?? ""] &&
    (step.reason !== "linear_workspace_scope_outdated" ||
      url.search === "?reauthorize=linear")
    ? href
    : undefined;
}

/** CTC-4629: the outdated-connection lines, built from the evidence the adapters recorded. */
function permissionText(
  step: OnboardStep,
  baseUrl?: string,
): string | undefined {
  const evidence = step.evidence ?? {};
  const url = actionUrl(step, baseUrl);
  const missing = evidenceText(evidence.missing);
  const org = evidenceText(evidence.org);
  const repository = evidenceText(evidence.repository);
  const github =
    evidence.actor === "github-account-owner"
      ? `The owner of the ${org ?? "installing"} GitHub account`
      : "An organization owner on GitHub";
  switch (step.reason) {
    case "github_app_permissions_outdated":
      if (!url) return undefined;
      return `The existing GitHub App installation${org ? ` on ${org}` : ""} needs updated permissions accepted${missing ? `: ${missing}` : ""}. ${GITHUB_CONFIRM_ACCESS} ${github} chooses Review permissions, then Accept new permissions at ${url}. Run catalyst onboard afterward.`;
    case "github_app_repository_missing":
      if (!url || !repository) return undefined;
      return `The GitHub App installation${org ? ` on ${org}` : ""} cannot reach ${repository}, which a project registers. ${github} adds it under Repository access at ${url}, then run catalyst onboard.`;
    case "github_app_repository_not_installed":
      if (!repository) return undefined;
      return `No GitHub App installation can reach ${repository}, which a project registers. A workspace owner or administrator installs the GitHub App on ${org ?? repository.split("/")[0]}: run catalyst onboard.`;
    case "linear_workspace_scope_outdated":
      if (!url) return undefined;
      return `The workspace's Linear connection (the Catalyst app) is missing scopes this version needs${missing ? `: ${missing}` : ""}. A workspace owner or administrator re-authorizes it at ${url}, then run catalyst onboard.`;
    case "linear_personal_scope_outdated":
      if (!url) return undefined;
      return `Your personal Linear connection is missing scopes this version needs${missing ? `: ${missing}` : ""}. Re-authorize it at ${url}, then run catalyst onboard.`;
  }
  return undefined;
}

/** A done step's detail line: what a connection was granted, when the check recorded it. */
export function onboardStepDetail(step: OnboardStep): string | undefined {
  const value = step.state === "done" ? step.evidence?.granted : undefined;
  const granted =
    typeof value === "string" &&
    value.length <= 512_000 &&
    /^[A-Za-z0-9 ._:;/(),-]+$/.test(value)
      ? value.length <= 2_000
        ? value
        : `${value.slice(0, 1_950)} (more permissions in the setup record)`
      : undefined;
  return granted ? `granted ${granted}` : undefined;
}

/** The dispatch stage's name as the contract gave it, or what it does when unknown. */
export function dispatchStageName(value: unknown): string {
  return typeof value === "string" && /^[\p{L}\p{N}][\p{L}\p{N} ._&'()-]{0,59}$/u.test(value)
    ? value
    : "the stage that starts Catalyst's work";
}

function firstTicketText(reason: string, key: string | undefined, stage: unknown): string | undefined {
  const move = `move one of ${key ? `${key}'s` : "your team's"} tickets to ${dispatchStageName(stage)} in Linear`;
  switch (reason) {
    case "first_ticket_choice_required":
      return `${move.charAt(0).toUpperCase()}${move.slice(1)}. Catalyst picks it up next.`;
    case "first_ticket_move_refused":
      return `Catalyst could not move the ticket for you. Ask a Catalyst owner or admin to check its Linear connection, or ${move} yourself.`;
    case "first_ticket_unavailable":
      return `Setup could not read or move the team's tickets. Run catalyst setup to try again, or ${move} yourself.`;
    case "first_ticket_unverified":
      return `Setup could not confirm which ticket moved. Check ${dispatchStageName(stage)} in Linear before choosing again.`;
  }
  return undefined;
}

/** One step's next action. `waitsFor` names the unfinished step a prerequisite wait is blocked on. */
export function onboardReasonText(
  step: OnboardStep,
  context: {
    baseUrl?: string;
    journal?: OnboardJournal;
    waitsFor?: string;
  } = {},
): string {
  const reason = step.reason ?? "";
  if (
    [
      "workspace_approval_required",
      "personal_approval_required",
      "github_installation_approval_required",
    ].includes(reason)
  ) {
    const path =
      reason === "workspace_approval_required"
        ? "/settings/connections?connect=linear"
        : reason === "github_installation_approval_required"
          ? "/connect/github/start"
          : `/settings/connected-accounts?connect=${step.id === "github.personal" ? "github" : "linear"}`;
    const where = context.baseUrl
      ? `${normalizeBaseUrl(context.baseUrl)}${path}`
      : "Catalyst settings";
    return `Open ${where} and approve this connection, then run catalyst onboard.`;
  }
  // CTC-4680: only a Catalyst owner or admin can start the GitHub install (the start route refuses
  // anyone else), so a member is told who to ask and where, on every channel.
  if (
    step.id === "github.install" &&
    (reason === "github_installation_admin_required" || reason === "member_scope")
  )
    return `Only an owner or admin of your Catalyst workspace can install Catalyst on GitHub. Ask one to open ${
      context.baseUrl ? `${normalizeBaseUrl(context.baseUrl)}/settings/connections` : "Catalyst settings, Integrations,"
    } and install it there.`;
  if (reason === "admin_setup_pending") {
    const words: Record<string, string> = {
      "linear.workspace": "connect Linear",
      "github.install": "install Catalyst on GitHub",
      "linear.adopt": "set up the team's Catalyst workflow",
    };
    const left = String(step.evidence?.admin ?? "")
      .split(",")
      .flatMap((id) => (words[id] ? [words[id]] : []));
    const list = left.length > 1 ? `${left.slice(0, -1).join(", ")} and ${left.at(-1)}` : (left[0] ?? "finish setup");
    return `A Catalyst owner or admin still has to ${list}. Ask one to open ${
      context.baseUrl ? `${normalizeBaseUrl(context.baseUrl)}/settings/connections` : "Catalyst settings"
    }, then run catalyst setup.`;
  }
  // A member is told which admin action is left and where an admin takes it.
  if (reason === "member_scope") {
    const key = onboardTeamKey(context.journal);
    if (step.id === "linear.adopt")
      return `Only a Catalyst owner or admin can set up the team's Catalyst workflow. Ask one to run catalyst team adopt ${key ?? "<TEAM KEY>"}.`;
    const adminOnly: Partial<Record<OnboardStep["id"], [string, string, string]>> = {
      "linear.workspace": ["connect Linear", "/settings/connections", " and connect it there"],
    };
    const admin = adminOnly[step.id];
    if (admin) {
      const [what, path, rest] = admin;
      const url = context.baseUrl ? `${normalizeBaseUrl(context.baseUrl)}${path}` : "Catalyst settings";
      return `Only a Catalyst owner or admin can ${what}. Ask one to open ${url}${rest}.`;
    }
  }
  // An install request can sit on GitHub for good (a wrong organization, or an owner who said no),
  // so the step always keeps a way to install it directly.
  if (reason === "github_installation_approval_pending" && context.baseUrl)
    return `${REASONS[reason] ?? ""} If you own the organization, or want a different one, install it at ${normalizeBaseUrl(context.baseUrl)}/connect/github/start.`;
  if (reason === "workflow_mapping_unverified")
    return `This team's workflow mapping is not verified yet. Run catalyst team adopt ${onboardTeamKey(context.journal) ?? "<TEAM KEY>"} to preview the adoption plan. Run it again with the --yes --plan-hash value it prints. Then run catalyst onboard.`;
  if (
    reason === "team_created_not_adopted" ||
    reason === "team_create_unverified"
  ) {
    const key = step.evidence?.teamKey;
    const team =
      typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(key)
        ? key
        : undefined;
    const adopt = (key: string) =>
      `Run catalyst team adopt ${key} to preview the adoption plan. Run it again with the --yes --plan-hash value it prints. Then run catalyst onboard.`;
    if (reason === "team_created_not_adopted")
      return `Linear team ${team ?? "<TEAM KEY>"} was created, but Catalyst's workflow is not set up on it yet. ${adopt(team ?? "<TEAM KEY>")}`;
    if (team)
      return `Setup could not confirm whether Linear created the team ${team}. Check Linear for it. If it is there: ${adopt(team)} If it is not, run catalyst onboard to create it again.`;
  }
  if (reason === "ai_account_not_usable") {
    const where = context.baseUrl
      ? `at ${normalizeBaseUrl(context.baseUrl)}/settings/coding-accounts`
      : "in the web app on the Settings → AI accounts page";
    return `No AI account in this workspace can take work yet. Run catalyst accounts to see which one needs work. A workspace owner or administrator fixes it ${where}, since no command does that yet: one may need its key replaced, or may have reached its usage limit. Then run catalyst onboard.`;
  }
  if (reason === "account_enrollment_required") {
    const where = context.baseUrl
      ? `at ${normalizeBaseUrl(context.baseUrl)}/settings/coding-accounts, the Settings → AI accounts page`
      : "in the web app on the Settings → AI accounts page";
    // CTC-4716: subscriptions are offered only to a workspace the cloud enables for them.
    const kinds = step.evidence?.aiAccountKinds;
    const what =
      typeof kinds === "string" && kinds.split(",").includes("subscription")
        ? "an API key, billed per token, or a subscription, a fixed monthly plan"
        : "an API key, billed per token";
    return `No AI account is added yet. A workspace owner or administrator adds one ${where}: ${what}. Then run catalyst onboard.`;
  }
  if (reason === "automation_management_unavailable") {
    const conflicts =
      typeof step.evidence?.automations === "string" &&
      /^(?:open|review|ready|merge)(?:,(?:open|review|ready|merge))*$/.test(
        step.evidence.automations,
      );
    if (!conflicts)
      return "could not read them; checked again before work starts";
    const key = onboardTeamKey(context.journal);
    const workspace = context.journal?.steps.find(
      (row) => row.id === "linear.workspace" && row.state === "done",
    );
    const slug = workspace?.evidence?.workspaceSlug;
    if (
      key &&
      /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(key) &&
      typeof slug === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(slug)
    )
      return `Open https://linear.app/${slug}/settings/teams/${key}/workflow and set each pull request automation to No action.`;
    return `Open your ${key ? `${key} team's` : "team's"} workflow settings in Linear and set each pull request automation to No action.`;
  }
  if (reason === "cloud_capability_unavailable") {
    // The capability guard records the web page in evidence.path only when it printed it.
    const page = webUrl(step.evidence?.path);
    return page
      ? `This setup step is not available on this server yet. Continue in the web app at ${page}, then run catalyst onboard.`
      : "This setup step is not available on this server yet. Run catalyst onboard after the server update.";
  }
  if(reason === "runner_native_egress_setup_required"){
    const commands=nativeEgressInstallCommands();
    return "Native Linux needs a root-managed session egress producer before the runner can take work. Its elevated installation creates the isolated session network and private-range and host-isolation nftables rules. Review and authorize this separately; setup has not run it. It requires systemd, python3, Docker and nftables. " + (commands ? "Install the verified bundled artifacts, then run the same setup command:\n"+commands : "Setup could not verify its bundled artifacts. Reinstall the CLI before authorizing installation.");
  }
  if (reason === "runner_images_unavailable" || reason === "runner_supervisor_image_unavailable") {
    const image = step.evidence?.image;
    const named =
      typeof image === "string" &&
      /^[a-z0-9][a-z0-9._:/-]{0,255}@sha256:[0-9a-f]{64}$/.test(image)
        ? ` ${image}`
        : "";
    return reason === "runner_supervisor_image_unavailable"
      ? `Setup could not verify or download the supervisor image required by this CLI release${named}. It has not started new work. Check network access and run the same setup command again.`
      : `This machine does not have the Catalyst image${named}, and its pull did not complete. Check network access and run the same setup command to retry the anonymous pull.`;
  }
  if (reason === "runner_org_key_missing") {
    const where = context.baseUrl
      ? `at ${normalizeBaseUrl(context.baseUrl)}/settings/account-keys`
      : "on the web app's Account API keys page";
    return `The runner is enrolled, but it takes no work without an organization key. A workspace owner or administrator runs catalyst onboard --runner on this machine; it mints the key and stores it for the runner. If their cloud cannot mint one yet, they create one with the mirror:read, mirror:write and mirror:feed scopes ${where}, save it in a file only they can read, and run catalyst onboard --runner with CATALYST_RUNNER_ORG_KEY_FILE set to that file.`;
  }
  if (reason === "runner_host_disk_sampler_conflict") {
    // Both settings are needed: a custom directory turns off setup's sampler, and the sample file
    // name is then empty unless it is set too.
    const safe = (value: unknown) => typeof value === "string" && /^\/[^\x00-\x1f'"]{0,500}$/.test(value) ? value : null;
    const dir = safe(step.evidence?.sampleDir) ?? "<directory the other agent writes to>";
    const file = safe(step.evidence?.sampleFile) ?? "/var/lib/catalyst/host-disk/<its file name>";
    return `Another dev.catalystcloud.host-disk LaunchAgent on this Mac writes its disk sample somewhere else, so setup left it alone and the runner has no disk measurement. To use that agent's sample, set both CATALYST_HOST_DISK_SAMPLE_DIR=${dir} and CATALYST_HOST_DISK_SAMPLE_FILE=${file}, then run catalyst setup --runner; the directory alone leaves the runner without a sample file. Or remove the other agent: run launchctl bootout gui/$(id -u)/dev.catalystcloud.host-disk and launchctl bootout user/$(id -u)/dev.catalystcloud.host-disk (one of them reports it is not loaded), delete ~/Library/LaunchAgents/dev.catalystcloud.host-disk.plist, then run catalyst setup --runner.`;
  }
  if (reason === "runner_host_disk_below_floor" || reason === "runner_host_disk_unmeasured") {
    const e = step.evidence ?? {};
    const num = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    const floorGiB = num(e.floorGiB) ?? DEFAULT_HOST_FREE_FLOOR_GIB, availableGiB = num(e.availableGiB);
    if (reason === "runner_host_disk_below_floor" && availableGiB === null)
      return `The runner advertises zero free slots: the disk it measures has less than ${floorGiB} GiB free. Free disk space, then run catalyst ready to see how much is free.`;
    const detail = typeof e.diskDetail === "string" && isRunnerDiskUnmeasured(e.diskDetail) ? e.diskDetail : "physical_host_disk_sample_required";
    const copy = runnerDiskCopy(reason === "runner_host_disk_below_floor" && availableGiB !== null
      ? { state: "below_floor", availableGiB, floorGiB }
      : { state: "unmeasured", detail, floorGiB }, e.vm === true);
    return `${copy.line} ${copy.fix}`;
  }
  if (reason === "runner_host_not_ready") {
    const failing = step.evidence?.failing;
    const checks =
      typeof failing === "string" && /^[a-z0-9.,_-]{1,500}$/.test(failing)
        ? `: ${failing.split(",").join(", ")}`
        : "";
    return `The runner is enrolled but its readiness checks fail${checks}. Run docker compose -p catalyst-host logs supervisor for the remedy, then run catalyst onboard again.`;
  }
  // CTC-5721: a Compose failure, or a paused older project, carries the evidence the adapter recorded.
  if (reason === "runner_compose_paused") {
    const services = typeof step.evidence?.services === "string" &&
        /^[a-z0-9][a-z0-9_-]{0,63}(,[a-z0-9][a-z0-9_-]{0,63})*$/.test(step.evidence.services)
      ? ` (${step.evidence.services.split(",").join(", ")})`
      : "";
    return `Setup found the existing catalyst-host Compose project's containers${services} paused and could not resume them. Run docker compose -p catalyst-host unpause to resume them, then run catalyst onboard --runner again. Setup removed nothing.`;
  }
  if (reason === "runner_compose_failed") {
    const project = typeof step.evidence?.project === "string" &&
        /^[a-z0-9][a-z0-9-]{0,63}$/.test(step.evidence.project)
      ? step.evidence.project
      : "catalyst-host";
    const error = typeof step.evidence?.composeError === "string" &&
        /^[\x20-\x7e]{1,500}$/.test(step.evidence.composeError)
      ? step.evidence.composeError.replace(/\.+$/, "")
      : undefined;
    return `Docker Compose could not start the runner project ${project}${error ? `: ${error}` : ""}. Run docker compose -p ${project} logs to see why, then run catalyst onboard --runner again.`;
  }
  if (reason === "runner_admission_operator")
    return `The admission policy for team ${onboardTeamKey(context.journal) ?? "<TEAM KEY>"} needs a Catalyst operator to check it. Setup changes only restricted admission and preserves existing policy fields. Ask Catalyst support to confirm a compatible policy, then run the same setup command.`;
  // CTC-4744: the cloud has not read the settings yet. Setup already waited a minute; this is
  // the cloud's work, not the person's.
  if (reason === "required_values_unread") {
    const which = typeof step.evidence?.repositories === "string" ? step.evidence.repositories : "this team's repositories";
    return `Catalyst hasn't finished reading the settings of ${which}, so it can't check the values yet. You don't need to do anything: Catalyst does this on its own, and catalyst ready shows when it's done.`;
  }
  if (reason === "required_values_missing") {
    let facts: unknown;
    try {
      facts = JSON.parse(String(step.evidence?.requiredValues ?? "null"));
    } catch {
      facts = null;
    }
    const fix =
      valuesFix(context.baseUrl, valuesFacts(facts)) ??
      valuesFix(context.baseUrl, { names: ["the missing values"] })!;
    // A member cannot set a value; the line says who does, and still never prints one.
    const member = context.journal?.steps.find((row) => row.id === "signin")?.evidence?.role === "member";
    if (member)
      return fix.startsWith("set ")
        ? `Ask a Catalyst owner or admin to ${fix}. Then run catalyst setup.`
        : `${fix.charAt(0).toUpperCase()}${fix.slice(1)}. Ask a Catalyst owner or admin to fix it, then run catalyst setup.`;
    return `${fix.charAt(0).toUpperCase()}${fix.slice(1)}. Then run catalyst setup.`;
  }
  const firstTicket = firstTicketText(reason, onboardTeamKey(context.journal), step.evidence?.stage);
  if (step.id === "first-ticket" && firstTicket) return firstTicket;
  if (reason === "prerequisite_not_ready" && context.waitsFor)
    return `Runs after "${context.waitsFor}".`;
  const permission = permissionText(step, context.baseUrl);
  if (permission) return permission;
  return REASONS[reason] ?? reason.replaceAll("_", " ");
}
