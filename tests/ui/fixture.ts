import { expect, type Page } from "@playwright/test";
// Exercise the real React UI and xterm with a controlled IPC boundary.
// Native process/CLI behavior is covered separately; no provider calls here.
export async function revealAssistant(page: Page) {
  const toggle = page.getByRole('button',{name:'Assistant settings',exact:true});
  if(await toggle.count() && await toggle.getAttribute('aria-expanded')==='false') await toggle.click();
}
export async function revealWorkspace(page: Page) {
  const chat = page.locator('.chat-wrap:not(.hidden)');
  if(!await chat.getByLabel('Workspace directory').isVisible()) await chat.getByRole('button',{name:'Project folder',exact:true}).click();
}
export async function pickProvider(page: Page, provider: string) {
  await revealAssistant(page);
  await page.getByLabel('AI provider').selectOption(provider);
  await expect(page.getByLabel('AI provider')).toHaveValue(provider);
  await revealAssistant(page);
  await revealWorkspace(page);
}
// Configuration tests reveal the controls explicitly. Pass false to inspect
// the focused default without changing preferences or mocking its layout.
export async function boot(page: Page, delay = 0, configure = true, waitForStartup = true) {
  await page.addInitScript(
    ({ delay }) => {
      const w = window as any;
      w.isTauri = true;
      const callbacks = new Map();
      const listeners = new Map();
      let serial = 0;
      let permissionMode = false, revision = 0, agentChecked = false, hostChecked = false;
      function accessReport(environment: string, agent: boolean) {
        return {checked_at:1800000001, environment, running:false, revision, permission_mode:permissionMode?'yolo':'standard', checks:
          ['directory_listing','known_file_read','file_creation','file_editing','read_back','cleanup'].map((operation,index)=>({operation,
            status:agent ? (agentChecked ? (api.blockAgentWrites && index>=2?'blocked':'pass') : 'untested') : (index===0?'pass':hostChecked?(api.readOnlyFolder&&index>=2?'fail':'pass'):'untested'),
            path:'<selected-project>/<unique-probe>',checked_at:agent&&!agentChecked?null:1800000001,environment,
            detail:agent&&api.blockAgentWrites&&index>=2?'Provider policy rejected the operation.':'Independent operation evidence.',error_code:null,exit_code:null}))};
      }
      const api = (w.qa = {
        calls: [] as any[],
        measurement: null as any,
        toolPermissions:{enabled:true,file_delete:true,vault_search:true,browser:true,native_screenshot:false,native_control:false},
        sessions: new Map(),
        agentQueues: new Map<string, any>(),
        interactions: new Map<string, any>(),
        failSend: false,
        antigravityInstalled: false,
        auth: {
          phase: "code",
          url: "https://accounts.google.com/o/oauth2/auth?state=fixture&code_challenge=test",
          message:
            "Sign in with Google, then paste the code from your browser.",
        },
        remote: {
          enabled: false,
          url: null as string | null,
          error: null,
          devices: [] as any[],
          pending: null as any,
          usb: null as any,
          tailscale: {
            installed: true,
            connected: true,
            hostname: "desktop.tail.ts.net",
            message: "Connected to your private network.",
          },
        },
        desktop: { notifications_enabled: true, last_error: null },
        pendingNavigation: null as string | null,
        updateStatus: {
          revision: 0, supported: false, automatic: true, current_version: "0.7.11",
          phase: "idle", version: null, downloaded: 0, total: null, checked_at: null, error: null,
          ...w.qaStartupStatus,
        },
        releaseStartup: null as null | ((restarting?: boolean) => void),
        startupFinished: false,
        update(change: Record<string, unknown>) {
          Object.assign(api.updateStatus, change, { revision: api.updateStatus.revision + 1 });
          api.emit("app-update-status", structuredClone(api.updateStatus));
        },
        emit(event: string, payload: unknown) {
          for (const [id, entry] of listeners) {
            if (entry.event === event)
              callbacks.get(entry.handler)?.({ event, id, payload });
          }
        },
        agent(event: any, target?: string) {
          const last = api.calls
            .filter((c: any) => c.cmd === "agent_send")
            .at(-1);
          const id = target || last.args.id;
          const state = api.agentQueues.get(id);
          if (state && event.kind === 'turn_end') {
            state.running = false;
            if (event.status !== 'completed' && state.queue.items.length) {
              state.queue.paused = true; state.queue.reason = 'Response stopped or failed. Review the queue, then resume.';
              publishQueue(id);
            }
          }
          api.emit("agent-event", { id, event });
          if (state && event.kind === 'turn_end' && event.status === 'completed') nextQueued(id);
        },
        listenerCount() {
          return listeners.size;
        },
      });
      function publishQueue(id: string) {
        const state = api.agentQueues.get(id);
        api.emit('agent-event', { id, event: {kind:'queue_state',queue:structuredClone(state.queue),running:state.running} });
      }
      function startTurn(id: string, message: any, queued: boolean) {
        api.agentQueues.get(id).running = true;
        api.emit('agent-event', {id,event:{kind:'turn_start',prompt:message.prompt,remote:!!message.remote,queued}});
      }
      function nextQueued(id: string) {
        const state = api.agentQueues.get(id);
        if (state.running || state.queue.paused || !state.queue.items.length) return;
        const message = state.queue.items.shift(); state.running = true;
        publishQueue(id); startTurn(id, message, true);
      }
      w.__TAURI_INTERNALS__ = {
        metadata: {
          currentWindow: { label: "main" },
          currentWebview: { label: "main" },
        },
        transformCallback(fn: unknown) {
          const id = ++serial;
          callbacks.set(id, fn);
          return id;
        },
        unregisterCallback(id: number) {
          callbacks.delete(id);
        },
        async invoke(cmd: string, args: any = {}) {
          api.calls.push({ cmd, args });
          if (cmd === "updates_status") return structuredClone(api.updateStatus);
          if (cmd === "updates_startup") {
            if (w.qaStartupIPCFailure) throw "Startup IPC unavailable";
            if (w.qaHoldStartup && !api.startupFinished) {
              api.update({ phase: "checking" });
              return await new Promise(resolve => {
                api.releaseStartup = (restarting = false) => {
                  api.startupFinished = true;
                  resolve({ restarting, status: structuredClone(api.updateStatus) });
                };
              });
            }
            api.startupFinished = true;
            return { restarting: false, status: structuredClone(api.updateStatus) };
          }
          if (cmd === "updates_skip_startup") {
            if (api.updateStatus.phase === "installing") throw "The installer has started";
            api.update({ phase: "idle" });
            api.releaseStartup?.(false);
            return;
          }
          if (cmd === "preferences_load") return w.qaPreferences ?? JSON.parse(localStorage.getItem("qa-native-preferences") || "null");
          if (cmd === "preferences_save") {
            if (api.holdPreferences) await new Promise<void>(resolve => { api.releasePreferences = resolve; });
            if (api.failPreferences) throw "Settings disk unavailable";
            api.preferences = structuredClone(args.profile);
            localStorage.setItem("qa-native-preferences", JSON.stringify(args.profile));
            return;
          }
          if (cmd === "history_desktop_load") return w.qaRecovery || null;
          if (cmd === "history_desktop_save") {
            if (api.holdHistorySave) await new Promise<void>(resolve => { api.releaseHistorySave = resolve; });
            if (api.failHistory) throw "Recovery disk unavailable";
            api.recovery = structuredClone(args.snapshot);
            return;
          }
          if (cmd === "history_draft_save") {
            if (api.failHistory) throw "Recovery disk unavailable";
            if (api.recovery?.tabs.some((tab: any) => tab.id === args.tabId)) api.recovery.drafts[args.tabId] = args.text;
            return;
          }
          if(cmd==='bots_request'){
            const q=args.request;let profiles=JSON.parse(localStorage.getItem('qa-bots')||'[]');
            if(q.action==='save'){if(api.botConflict)throw 'This bot was edited elsewhere. Reload before saving.';profiles=[...profiles.filter((b:any)=>b.id!==q.profile.id),{...q.profile,revision:`r${++serial}`}];}
            if(q.action==='delete')profiles=profiles.filter((b:any)=>b.id!==q.id);
            localStorage.setItem('qa-bots',JSON.stringify(profiles));return {profiles,root:'C:\\Bots',warnings:[]};
          }
          if(cmd==='automation_request'){
            const q=args.request;api.jobs||={enabled:true,jobs:[],runs:[],warning:null};
            if(q.action==='preview'){if(q.timezone==='invalid')throw 'Choose an IANA timezone';return {times:[1800000000,1800000900,1800001800]};}
            if(q.action==='configure')api.jobs.enabled=q.enabled;
            const job=api.jobs.jobs.find((j:any)=>j.id===q.id);
            if(q.action==='pause')job.paused=q.paused;
            if(q.action==='run')job.status='running';
            if(q.action==='stop'){job.status='cancelled';job.paused=true;}
            return structuredClone(api.jobs);
          }
          if (cmd === "git_state") {
            if (args.workspace?.includes("plain")) throw "No Git repository detected.";
            if (args.workspace?.includes("flaky")) {
              api.gitFlakyCalls = (api.gitFlakyCalls || 0) + 1;
              if (api.gitFlakyCalls <= (api.gitFlakyFailures ?? 0))
                throw "Git branch timed out or could not be monitored; no Git configuration was changed.";
              return {
                root: "C:\\Flaky",
                current: "flaky-branch",
                branches: [{ name: "flaky-branch", upstream: "", head: "c0ffee1" }],
                branches_truncated: false,
                status: "## flaky-branch\n M src/Flaky.tsx",
                status_truncated: false,
                log: [],
                log_truncated: false,
                upstream: "",
                ahead: 0,
                behind: 0,
                trust: "Selected repository only, for this command.",
                global_config_changed: false,
              };
            }
            if (args.workspace?.includes("second")) {
              return {
                root: "C:\\Second",
                current: "feature/two",
                branches: [{ name: "feature/two", upstream: "", head: "b1af248" }],
                branches_truncated: false,
                status: "## feature/two\n M src/Other.tsx",
                status_truncated: false,
                log: [],
                log_truncated: false,
                upstream: "",
                ahead: 0,
                behind: 0,
                trust: "Selected repository only, for this command.",
                global_config_changed: false,
              };
            }
            return {
              root: "C:\\Projects\\VelumCode",
              current: "main",
              branches: [
                { name: "main", upstream: "origin/main", head: "a232474" },
                { name: "improve/ui-customization", upstream: "", head: "b1af248" },
              ],
              branches_truncated: false,
              status: "## main...origin/main\n M src/App.tsx\n?? src/components/GitPanel.tsx",
              status_truncated: false,
              log: [
                { hash: "a2324740000000000000000000000000000000000", short: "a232474", author: "Velum Test", date: "2026-10-03", subject: "Polish conversation layout" },
                { hash: "b1af2480000000000000000000000000000000000", short: "b1af248", author: "Velum Test", date: "2026-10-02", subject: "Add Git diff panel" },
              ],
              log_truncated: false,
              upstream: "origin/main",
              ahead: 0,
              behind: 0,
              remote_url: "https://github.com/velumix/VelumCode.git",
              trust: "Selected repository only, for this command.",
              global_config_changed: false,
            };
          }
          if (cmd === "git_file_diff") {
            if (args.path === "src/components/GitPanel.tsx")
              return {
                base: args.base || "HEAD",
                path: args.path,
                diff: `diff --git a/${args.path} b/${args.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${args.path}\n@@ -0,0 +1,2 @@\n+line one\n+line two`,
                truncated: false,
                untracked: true,
                trust: "Selected repository only, for this command.",
                global_config_changed: false,
              };
            if (args.path)
              return {
                base: args.base || "HEAD",
                path: args.path,
                diff: `diff --git a/${args.path} b/${args.path}\n--- a/${args.path}\n+++ b/${args.path}\n@@ -1 +1 @@\n-old\n+new`,
                truncated: false,
                untracked: false,
                trust: "Selected repository only, for this command.",
                global_config_changed: false,
              };
            return {
              base: args.base || "HEAD",
              path: "",
              diff: " src/App.tsx | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)",
              truncated: false,
              trust: "Selected repository only, for this command.",
              global_config_changed: false,
            };
          }
          if (cmd === "github_auth_status") {
            return {
              has_pat: false,
              has_cli: true,
              cli_account: "velumix",
              active_source: "cli",
            };
          }
          if (cmd === "github_user_profile") {
            return {
              authenticated: true,
              login: "velumix",
              name: "Velumix",
              avatar_url: "https://avatars.githubusercontent.com/u/159978288?v=4",
              bio: "Desktop AI coding companion",
              company: null,
              location: null,
              blog: "",
              email: null,
              public_repos: 28,
              total_private_repos: 9,
              followers: 1,
              following: 0,
              html_url: "https://github.com/velumix",
              auth_source: "cli",
              scopes: ["repo", "user"],
              rate_limit_limit: 5000,
              rate_limit_remaining: 4990,
            };
          }
          if (cmd === "github_repo_details") {
            return {
              owner: "velumix",
              name: "VelumCode",
              full_name: "velumix/VelumCode",
              description: "A Windows home for Muse, Codex and Google Antigravity.",
              private: false,
              fork: false,
              html_url: "https://github.com/velumix/VelumCode",
              clone_url: "https://github.com/velumix/VelumCode.git",
              ssh_url: "git@github.com:velumix/VelumCode.git",
              stars: 12,
              forks: 3,
              open_issues_count: 2,
              default_branch: "main",
              topics: ["tauri", "react", "rust"],
              permissions: { admin: true, push: true, pull: true },
              visibility: "public",
            };
          }
          if (cmd === "github_repo_pulls") {
            return [
              {
                number: 42,
                title: "Support GitHub live identity and repository hub",
                user_login: "velumix",
                user_avatar: "https://avatars.githubusercontent.com/u/159978288?v=4",
                state: "open",
                draft: false,
                html_url: "https://github.com/velumix/VelumCode/pull/42",
                created_at: "2026-10-04T20:00:00Z",
                updated_at: "2026-10-04T20:30:00Z",
                head_ref: "feature/github-hub",
                base_ref: "main",
              },
            ];
          }
          if (cmd === "github_repo_issues") {
            return [
              {
                number: 10,
                title: "Add GitHub pull request and issue browser",
                user_login: "velumix",
                user_avatar: "https://avatars.githubusercontent.com/u/159978288?v=4",
                state: "open",
                labels: [{ name: "enhancement", color: "a2eeef" }],
                comments: 4,
                html_url: "https://github.com/velumix/VelumCode/issues/10",
                created_at: "2026-10-04T18:00:00Z",
                updated_at: "2026-10-04T19:00:00Z",
              },
            ];
          }
          if (cmd === "github_create_issue") {
            return {
              number: 11,
              title: args.title || "New Issue",
              user_login: "velumix",
              user_avatar: "https://avatars.githubusercontent.com/u/159978288?v=4",
              state: "open",
              labels: [],
              comments: 0,
              html_url: "https://github.com/velumix/VelumCode/issues/11",
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            };
          }
          if (cmd === "github_save_pat") {
            return {
              authenticated: true,
              login: "velumix",
              name: "Velumix",
              avatar_url: "https://avatars.githubusercontent.com/u/159978288?v=4",
              html_url: "https://github.com/velumix",
              auth_source: "pat",
              scopes: ["repo", "user"],
              public_repos: 28,
              followers: 1,
              following: 0,
            };
          }
          if (cmd === "github_clear_pat") {
            return null;
          }
          if (cmd === "kanban_request") {
            const key = `qa-board:${args.workspace}`;
            const board = JSON.parse(localStorage.getItem(key) || '{"revision":0,"cards":[]}');
            const q = args.request;
            board.trash ||= [];
            if(q.action !== "load") {
              if(api.boardConflict || board.revision !== q.revision) throw "This board changed on another screen. Refresh the board before trying again. Your unsaved card is still here.";
              if(q.action === "save") { const index=board.cards.findIndex((c:any)=>c.id===q.card.id);if(index<0)board.cards.push(q.card);else board.cards[index]=q.card; }
              if(q.action === "delete") {board.trash.unshift({card:board.cards.find((c:any)=>c.id===q.id),deleted_at:Date.now()/1000});board.cards=board.cards.filter((c:any)=>c.id!==q.id);}
              if(q.action === "restore") {const card=board.trash.find((e:any)=>e.card.id===q.id).card;if(card.assignment)card.assignment.automatic=false;card.last_run=null;board.cards.push(card);board.trash=board.trash.filter((e:any)=>e.card.id!==q.id);}
              if(q.action === "purge")board.trash=board.trash.filter((e:any)=>e.card.id!==q.id);
              if(q.action === "move") {const c=board.cards.find((c:any)=>c.id===q.id);board.cards=board.cards.filter((c:any)=>c.id!==q.id);c.column=q.column;const i=q.before?board.cards.findIndex((c:any)=>c.id===q.before):board.cards.length;board.cards.splice(i,0,c);}
              board.revision++;localStorage.setItem(key,JSON.stringify(board));
            }
            return structuredClone(board);
          }
          if (cmd === "memory_request" || cmd==='bots_memory') {
            const key=cmd==='bots_memory'?`memory:${args.id}`:'memory';
            api[key] ||= {
              root: "C:\\Documents\\Velum Code\\Memory",
              settings: {
                enabled: true,
                capture: "review",
                budget_bytes: 3000,
              },
              notes: [],
              warning: null,
            };
            const q = args.request,
              m = api[key];
            if (q.action === "configure") m.settings = q.settings;
            if (q.action === "delete")
              m.notes = m.notes.filter((n: any) => n.id !== q.id);
            if (q.action === "save" || q.action === 'save_lesson') {
              if (api.holdMemorySave) await new Promise<void>(resolve => { api.releaseMemorySave = resolve; });
              if (api.memoryConflict)
                throw "This note changed elsewhere. Refresh to load the latest copy before saving.";
              const existing = q.action==='save_lesson' ? m.notes.find((note:any)=>note.scope==='project'&&note.status!=='archived'&&note.body.trim()===q.body.trim()) : undefined;
              if(existing?.status==='active'&&existing.pinned)return structuredClone(m);
              const note = {
                ...q,
                ...(q.action==='save_lesson'?{scope:'project',status:'active',pinned:true,tags:['lesson','correction']}:{}),
                id: existing?.id || q.id || `note-${++serial}`,
                revision: `r-${serial}`,
                source: q.action==='save_lesson'?'Reviewed correction':'Saved by you',
                created_at: 1,
                updated_at: 1,
              };
              m.notes = [...m.notes.filter((n: any) => n.id !== note.id), note];
              api.emit('memory-changed',{});
            }
            return structuredClone(m);
          }
          if (cmd === "provider_models")
            return api.failModels
              ? { models: [], notice: "Sign in to load models." }
              : {
                  models: [
                    {
                      id: `${args.provider}-deep`,
                      label: "Deep model",
                      description: "Complex work",
                      efforts: ["low", "high", "max"],
                      default_effort: "high",
                    },
                    {
                      id: `${args.provider}-fast`,
                      label: "Fast model",
                      description: "Quick work",
                      efforts: ["low"],
                      default_effort: "low",
                    },
                    {
                      id: `${args.provider}-basic`,
                      label: "Basic model",
                      description: "No reasoning controls",
                      efforts: [],
                      default_effort: "",
                    },
                  ],
                  notice: null,
                  defaults: api.modelDefaults,
                };
          if (cmd === "agent_configure") {
            if (api.failConfigure) throw "Wait for the current response.";
            api.emit("agent-options", {
              tab_id: args.tabId,
              options: args.options,
            });
            return;
          }
          if (cmd === "provider_status")
            return ["muse", "codex", "antigravity"].map((id) => ({
              id,
              installed: id !== "antigravity" || api.antigravityInstalled,
              setup_url:
                "https://antigravity.google/docs/getting-started?tab=cli",
            }));
          if (cmd === "provider_warmup")
            return w.qaFailWarmup
              ? { installed: true, version: null, catalog_models: 0, catalog_notice: "Warmup failed.", elapsed_ms: 5 }
              : { installed: true, version: "Muse Code 1.4.2", catalog_models: 2, catalog_notice: null, elapsed_ms: 12 };
          if (cmd === "antigravity_login_status") return { ...api.auth };
          if (cmd === "antigravity_login_submit") {
            api.auth = {
              phase: "complete",
              url: "",
              message: "Antigravity is connected.",
            };
            return;
          }
          if (cmd === "remote_status" || cmd === "remote_check_tailscale")
            return { ...api.remote };
          if (cmd === "remote_usb_devices")
            return [
              { serial: "PIXEL_TEST", name: "Pixel 7 Pro", authorized: true },
              { serial: "LOCKED", name: "Android phone", authorized: false },
            ];
          if (cmd === "remote_usb_connect") {
            api.remote.usb = {
              serial: args.serial,
              name: "Pixel 7 Pro",
              authorized: true,
            };
            return { ...api.remote };
          }
          if (cmd === "remote_usb_disconnect") {
            api.remote.usb = null;
            return { ...api.remote };
          }
          if (cmd === "remote_enable") {
            api.remote.enabled = args.enabled;
            api.remote.url = args.enabled
              ? "https://desktop.tail.ts.net:8443"
              : null;
            return { ...api.remote };
          }
          if (cmd === "remote_pair")
            return {
              url: "https://desktop.tail.ts.net:8443/#pair=test",
              code: "482196",
              expires_at: Math.floor(Date.now() / 1000) + 120,
              svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="white"/></svg>',
            };
          if (cmd === "remote_approve") {
            api.remote.devices.push({
              id: "phone",
              name: api.remote.pending.name,
              control: args.control,
              created_at: Math.floor(Date.now() / 1000),
            });
            api.remote.pending = null;
            return;
          }
          if (cmd === "remote_cancel_pairing") {
            api.remote.pending = null;
            return;
          }
          if (cmd === "remote_revoke") {
            api.remote.devices = api.remote.devices.filter(
              (d: any) => d.id !== args.id,
            );
            return;
          }
          if (cmd === "desktop_status") return api.desktop;
          if (cmd === "desktop_set_notifications") {
            api.desktop.notifications_enabled = args.enabled;
            return { ...api.desktop };
          }
          if (cmd === "desktop_take_navigation") {
            const id = api.pendingNavigation;
            api.pendingNavigation = null;
            return id;
          }
          if (cmd === "plugin:event|listen") {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            const id = ++serial;
            listeners.set(id, args);
            return id;
          }
          if (cmd === "plugin:event|unlisten") {
            listeners.delete(args.eventId);
            return;
          }
          if (cmd === "agent_validate_workspace") {
            if (args.workspace?.includes('denied')) throw 'Velum cannot list this folder. Check Windows folder access.';
            if (args.workspace?.includes("missing"))
              throw "workspace is not a directory";
            return args.workspace || "C:\\QA";
          }
          if (cmd === 'workspace_pick') return api.pickedFolder || null;
          if (cmd === 'workspace_check') {
            hostChecked=true;
            return {path:args.workspace,checked_at:1800000001,readable:true,writable:!api.readOnlyFolder,message:'Host filesystem results only.',sanitized:accessReport('Velum host process',false)};
          }
          if (cmd === 'agent_set_permissions') {
            const changed=permissionMode!==args.yolo;
            if(changed){revision++;agentChecked=false;hostChecked=false;}
            permissionMode=args.yolo;
            if(changed)api.emit('agent-event',{id:args.id,event:{kind:'notice',text:'Permission mode changed. A fresh provider conversation will start. Workspace checks were invalidated.'}});
            return {yolo:permissionMode,new_session:changed,checks_invalidated:changed};
          }
          if (cmd === 'agent_check_access') {
            agentChecked=true;hostChecked=true;
            setTimeout(()=>api.emit('agent-event',{id:args.id,event:{kind:'turn_end',status:'completed'}}),10);
            return {id:args.id,turn_id:'probe-turn'};
          }
          if(cmd === 'agent_tools_status' || cmd === 'agent_tools_configure' || cmd === 'agent_tools_disconnect') {
            if(cmd==='agent_tools_configure') api.toolPermissions={...args.permissions};
            if(cmd==='agent_tools_disconnect') (api as any).toolDisconnected=true;
            return {permissions:api.toolPermissions,ready:true,browser_available:true,native_available:true,providers:[{provider:'muse',installed:true,registration:(api as any).toolDisconnected?'on_next_turn':'configured'},{provider:'codex',installed:true,registration:'per_turn'}]};
          }
          if (cmd === 'app_diagnostics') {
            if (api.failDiagnostics) throw 'Diagnostics unavailable';
            return {turn_measurement:api.measurement,app:'Velum Code',version:'0.6.1',host_os:'windows',checked_at:1800000000,workspace:{path:'<selected-project>',git_repository:true,message:'Host and agent results are separate.'},
              workspace_access:{host:accessReport('Velum host process',false),agent:accessReport('Muse agent tools',true),selection:{kind:args.workspace==='C:\\profile-home'?'user_profile_root':'project_directory',guidance:args.workspace==='C:\\profile-home'?'Choose a project folder and Apply it before coding in Codex Standard mode.':null},permissions:{requested_mode:permissionMode?'yolo':'standard',launched_mode:agentChecked?(permissionMode?'yolo':'standard'):null,revision,effective:{status:'untested'}}},
              connections:[{name:'GitHub',status:'untested',detail:'No live health evidence.'}],attachments:{detail:'Velum does not discover provider UI/document sessions.'},
              providers:[{provider:'muse',installed:true,authentication:'not checked',tool_connections:'not checked'},{provider:'antigravity',installed:true,authentication:'not checked',tool_connections:'not checked'}],memory:{readable:true,enabled:true,notes:2,budget_bytes:3000,capture:'review'},sessions:{active:0,failed:0,blocked:0}};
          }
          if (cmd === 'agent_interactions') return structuredClone(api.interactions.get(args.id) || {generation:'',revision:0,active:false,requests:[]});
          if (cmd === 'agent_respond') {
            if(api.holdResponse) await new Promise<void>(resolve => { api.releaseResponse = resolve; });
            if(api.failResponse) throw 'This request changed or already received a response. Review its current state.';
            const snapshot=api.interactions.get(args.id), decision=args.decision;
            const request=snapshot?.requests.find((r:any)=>r.id===decision.id);
            if(!snapshot?.active || snapshot.generation!==decision.generation || !request || request.revision!==decision.revision || request.status!=='pending') throw 'This request changed or already received a response. Review its current state.';
            request.status='submitting';request.source='desktop';snapshot.revision++;
            api.emit('agent-interactions',{id:args.id,snapshot:structuredClone(snapshot)});
            return structuredClone(snapshot);
          }
          if (cmd === "agent_new") {
            if (delay) await new Promise((r) => setTimeout(r, delay));
            if (api.holdAgentNew) await new Promise<void>(resolve => { api.releaseAgentNew = resolve; });
            if (args.workspace?.includes("missing"))
              throw "workspace is not a directory";
            api.sessions.set(args.id, "agent");
            const restored = w.qaAgentRestore || [];
            const savedQueue = [...restored].reverse().find((e:any)=>e.kind==='queue_state')?.queue;
            api.agentQueues.set(args.id, {running:false,queue:structuredClone(savedQueue || {items:[],paused:false,reason:null})});
            const bot=JSON.parse(localStorage.getItem('qa-bots')||'[]').find((b:any)=>b.id===args.botId);
            if(bot)api.emit('agent-event',{id:args.id,event:{kind:'bot_identity',bot}});
            return {
              id: args.id,
              session_id: `native-${args.id}`,
              workspace: args.workspace || "C:\\QA",
              workspace_notice: args.workspace==='C:\\profile-home'?'Choose a project folder and Apply it before coding in Codex Standard mode.':null,
              restored,
            };
          }
          if (cmd === "agent_send") {
            if (api.holdSend) await new Promise<void>(resolve => { api.releaseSend = resolve; });
            if (api.failSend) throw "Could not launch muse";
            const state = api.agentQueues.get(args.id);
            if (state.running || state.queue.items.length || state.queue.paused) {
              if(state.queue.items.length>=20)throw 'Queue is full. Remove a queued message before adding another.';
              state.queue.items.push({id:crypto.randomUUID(),prompt:args.prompt,yolo:args.yolo,remote:!!args.remote});
              publishQueue(args.id);
              return {id:args.id,turn_id:'',queued:true};
            }
            startTurn(args.id,args,false);
            return { id: args.id, turn_id: "turn", queued:false };
          }
          if (cmd === 'agent_queue') {
            if(api.failQueue)throw 'Queue unavailable';
            const state = api.agentQueues.get(args.id), q=state.queue, request=args.request;
            if(request.action==='pause'){q.paused=true;q.reason='Queue paused by you.';}
            if(request.action==='resume'){q.paused=false;q.reason=null;}
            if(request.action==='clear'){q.items=[];q.paused=false;q.reason=null;}
            if(request.action==='remove'){q.items=q.items.filter((m:any)=>m.id!==request.message_id);if(!q.items.length){q.paused=false;q.reason=null;}}
            if(request.action==='edit'){const message=q.items.find((m:any)=>m.id===request.message_id);if(!message)throw 'Queued message already started.';message.prompt=request.prompt.trim();}
            publishQueue(args.id);nextQueued(args.id);return structuredClone(q);
          }
          if (cmd === "agent_stop") {
            const snapshot=api.interactions.get(args.id);
            if(snapshot){snapshot.active=false;snapshot.revision++;for(const request of snapshot.requests)if(['pending','submitting'].includes(request.status))request.status='expired';api.emit('agent-interactions',{id:args.id,snapshot:structuredClone(snapshot)});}
            api.agent({kind:'turn_end',status:'cancelled'},args.id);
            return;
          }
          if (cmd === "agent_destroy" || cmd === "pty_kill") {
            api.sessions.delete(args.id);
            api.agentQueues.delete(args.id);
            return;
          }
          if (cmd === "pty_spawn") {
            api.sessions.set(args.id, "terminal");
            setTimeout(
              () =>
                api.emit("pty-data", {
                  id: args.id,
                  data: "hello terminal\r\nsearch target\r\n",
                }),
              30,
            );
            return { id: args.id, backend: "fixture muse" };
          }
          if (cmd === "plugin:window|is_maximized") return false;
        },
      };
      w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
        unregisterListener(_event: string, id: number) {
          listeners.delete(id);
        },
      };
    },
    { delay },
  );
  await page.goto("/");
  if (!waitForStartup) return;
  await expect(page.locator("#startup")).toHaveCount(0);
  await expect(page.locator("#root")).not.toHaveAttribute("inert", "");
  await expect(page.locator(".chat-wrap:not(.hidden) textarea")).toBeEnabled();
  await expect(page.locator(".model-controls")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  if(configure){await revealAssistant(page);await revealWorkspace(page);await page.locator('.chat-wrap:not(.hidden) .composer textarea').focus();}
}
