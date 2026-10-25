# Desktop UI acceptance inventory

Target: original Heyuna React surface, real authenticated localhost API, desktop 1440×960 and narrow 390×844. Browser preview does not prove native OS file-dialog or signed-package behavior.

| Surface/control | Functional check | Visual state | Evidence |
|---|---|---|---|
| Navigation, refresh, theme | All five views; light/dark and refresh | Sidebar/content, unavailable services | screenshots + console |
| Workspace | Open dialog; explicit path in development and folder picker in native app; no model/sandbox disables submit | Empty, unavailable, selected files/diff if reachable | preview and API tests |
| Training | Opt-in off; model preparation; pause/stop; settings | Not connected, off, network failure | preview + protocol tests |
| Wallet | Fixed supply, chain identity, separate states | No deployment → connect/claim disabled | screenshot + UI test |
| Contributions | Filter/empty-state, explicit verification states | Empty; no fabricated receipts | screenshot + protocol tests |
| Settings | Validate/save windows/resource/upload limits; CPU enforcement disclosure | Saved light/dark | UI + persisted API |
| Accessibility | Keyboard focus, accessible controls, zoom, responsive overflow | 390×844 and 1440×960 | bounds + screenshot |
| Off-happy-path | Unknown coordinator/missing runtime, backend authorization failure | Explicit reason, no host fallback or fake balance | integration tests |

Real model execution is recorded in agent-smoke.json: normal preview UI started the task, reviewed its real diff, applied it and reverted it. Filesystem checks confirmed the original was untouched before apply and exactly restored after UI revert. Navigating away from and back to the diff produced zero page errors after a Monaco lifecycle fix. Browser state is currently transient, so review/revert should be completed before closing the session. The source backend's task records are also in-memory.

Keyboard Escape closes the project dialog and returns focus to its opener. 200% text sizing was inspected on settings and workspace: no page horizontal overflow at 1440px; the initial clipped brand was reported and corrected before final capture. 390px layout has no page horizontal overflow. All five views, light/dark, persisted upload cap and unavailable deployment state were checked. No browser page errors were observed.

Production wallet signing, native screen-reader traversal and Windows rendering require their own evidence. The macOS application was packaged and launched, but native visual inspection was unavailable while the workstation was locked.
