# TWC Stafford Music Scheduler

Windows desktop music scheduler built with Electron, React, TypeScript, and Vite. Application data and logs are stored in the Electron user-data directory. Spotify credentials are stored separately with Electron `safeStorage`.

## Commands

```powershell
npm install
npm run dev
npm test
npm run build
npm run package:win
```

The NSIS installer is written to `release/`. The Windows icon and Poppins font files are included under `assets/`.

## Spotify setup and limitations

Create an app in the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard), put its Client ID in Settings, then select **Connect Spotify**. The app uses Authorization Code with PKCE and opens the system browser. Requested scopes are `user-read-private`, `user-read-playback-state`, `user-modify-playback-state`, `playlist-read-private`, and `playlist-read-collaborative`. No client secret is used. Spotify currently requires Premium for Web API playback controls; a Spotify device must be available and active. Device-specific volume control can be unavailable.

**Release blocker:** Spotify's Developer Policy prohibits products targeted at businesses or retail employees and prohibits public playback from a business. This app is a Stafford workplace music scheduler, so its Spotify playback integration is not suitable for production use in that setting without written authorization. Use a properly licensed commercial music service or obtain the required authorization before release. See [Spotify's Developer Policy](https://developer.spotify.com/policy).

Playlist refresh retrieves the current user's playlists in pages and stores IDs, names, track totals, and artwork URLs. Default and schedule playlist IDs persist locally.

## Google Business Profile hours

The Settings page supports OAuth from a Google OAuth **Desktop app** client ID, then reads account locations and hours from the official Business Profile Account Management and Business Information APIs using the `business.manage` scope. OAuth is handled in Electron's main process; Google refresh tokens are encrypted with Electron `safeStorage` and are never returned to the renderer. A client secret is not collected or embedded. Use **Load demo/test data** to explore the weekly-hours preview and import flow without connecting Google; demo data is clearly marked and never represents live business information.

Before live use, create/configure a Google Cloud project, enable the Business Profile Account Management API and Business Profile Business Information API, configure the OAuth consent screen and a Desktop app OAuth client, and ensure Google has granted the project access to Business Profile APIs. Google restricts these APIs and access may require a separate approval process. Enter the OAuth client ID in Settings. If the project is not approved, the app reports the API permission/configuration error and demo mode remains available. Select a Spotify playlist before importing. Regular business hours become recurring music schedules; special dates create scoped overrides without changing unrelated schedule entries. Confirm imported overlaps against existing schedules in the schedule editor.

## Scheduling behavior

Recurring start and end times are read from the Windows computer's local JavaScript `Date` fields in the Electron main process. The scheduler does not pin a time zone; DST and time-zone changes are picked up by polling current local time. A persisted event ledger prevents executing a boundary more than once. Music schedules start the assigned Spotify playlist and pause it at the end only if that same playlist is still playing. Quiet schedules persist the active playback context, track, position, and prior playing state before pausing. At the end, the app restores the playlist/track/position only when playback had been active beforehand. If the app starts during a quiet period without a snapshot, it enforces quiet and does not resume anything.

The application must remain open for scheduling. Closing its last window quits the app; there is no tray process or Windows service. Boundary actions missed while the app is closed or the PC is asleep are skipped. On startup or wake, an active quiet period is re-applied. A music period already in progress is not started retroactively. Boundary actions are claimed before execution, so a crash in the narrow interval after a claim and before the Spotify request can skip that occurrence; this is the at-most-once policy used to prevent duplicate playback commands. Date exceptions apply to a schedule occurrence's local start date: skip suppresses its music start, while replace uses the selected playlist for its start and matching end boundary.

Local announcement audio can be imported as MP3 or WAV, previewed, enabled or disabled, and scheduled once or on selected weekdays. Announcement playback runs in the renderer, so the app must remain open at the scheduled time. Legacy date/label exception entries are migrated to skip exceptions when loaded.

## Audio test

The audio test generates a short tone through Chromium's Windows default audio output. It is blocked during active quiet hours and while Spotify playback is active. The app can confirm that the tone was sent to the output pipeline; the user must confirm that it was audible.

## Security and data

Electron uses context isolation, disabled Node integration, and a sandboxed preload with narrowly scoped IPC methods. IPC checks the sender, navigation is restricted to the app, and a Content Security Policy is configured. Store writes are serialized and use temporary-file rename. PKCE state and the loopback callback origin are validated. Tokens are encrypted with Windows secure storage and are never returned to the renderer. The app enforces a single instance and stops its scheduler when quitting.

## Testing and packaging

`npm test` compiles the Electron process modules and runs schedule, local-time display, overnight quiet interval, exception behavior, quiet playback snapshot/restore policy, duplicate event claim, OAuth callback validation, and Spotify error-format tests. `npm run build` type-checks and builds the renderer and Electron process. Live Spotify behavior requires the user's configured Spotify Client ID, authorization, Premium eligibility, and an active device; those external workflows must be verified on the target PC.
