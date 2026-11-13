import { useEffect, useMemo, useRef, useState } from "react";
import {
  Music2,
  House,
  CalendarDays,
  ListMusic,
  Settings as SettingsIcon,
  ScrollText,
  Info,
  Circle,
  ChevronRight,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Monitor,
  Moon,
  Volume2,
  Plus,
  Trash2,
  Pencil,
  X,
  Check,
  RefreshCw,
  FileUp,
  ExternalLink,
  Menu,
  Megaphone,
  Minus,
  Square,
} from "lucide-react";
import {
  schedulesConflict,
  validateSchedule,
  nextScheduledAction,
  formatLocalDateTime,
} from "./schedule.mjs";
import {
  parseBusinessHours,
  importHoursAsSchedules,
  resolveGoogleImportPlan,
  demoBusinessHours,
} from "./google-hours.mjs";
import {
  parseBusinessHoursCsv,
  downloadBusinessHoursCsvTemplate,
} from "./business-hours-csv.mjs";
import {
  announcementEventsAt,
  announcementWindowActive,
  validateAnnouncementSchedule,
  saveAnnouncementSchedule,
  removeAnnouncementSchedule,
  setAnnouncementScheduleEnabled,
  upcomingAnnouncementOccurrences,
} from "./announcement-scheduler.mjs";
import {
  validateAdvertisementSchedule,
  saveAdvertisementSchedule,
  removeAdvertisementSchedule,
  setAdvertisementScheduleEnabled,
} from "../electron/advertisement-schedule";
type Page =
  | "Home"
  | "Schedule"
  | "Audio Manager"
  | "Playlists"
  | "Settings"
  | "Logs"
  | "About";
type Schedule = {
  id: string;
  name: string;
  days: string[];
  date?: string;
  repeat?: "never" | "daily" | "weekly" | "monthly" | "yearly";
  start: string;
  end: string;
  playlistId: string;
  playlistName: string;
  enabled: boolean;
  quiet: boolean;
};
const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const newAdvertisementScheduleForm = () => ({
  id: "",
  name: "",
  type: "weekly" as "weekly" | "random" | "repeat",
  days: [] as string[],
  start: "09:00",
  end: "17:00",
  times: [] as string[],
  timeDraft: "10:00",
  advertisementIds: [] as string[],
  minIntervalMinutes: 30,
  maxIntervalMinutes: 60,
  repeatIntervalMinutes: 15,
  rotate: true,
  enabled: true,
});
const seed = {
  settings: {
    spotifyClientId: "",
    defaultPlaylist: "",
    schedulerEnabled: true,
  },
  schedules: [] as Schedule[],
  exceptions: [] as any[],
  playlists: [] as any[],
  logs: [] as any[],
  announcements: [] as any[],
  announcementSchedules: [] as any[],
  advertisements: [] as any[],
  advertisementSchedules: [] as any[],
};
const nav: { name: Page; icon: any }[] = [
  { name: "Home", icon: House },
  { name: "Schedule", icon: CalendarDays },
  { name: "Audio Manager", icon: Megaphone },
  { name: "Playlists", icon: ListMusic },
  { name: "Settings", icon: SettingsIcon },
  { name: "Logs", icon: ScrollText },
  { name: "About", icon: Info },
];
export default function App() {
  const [page, setPage] = useState<Page>("Home"),
    [data, setData] = useState<any>(seed),
    [branding, setBranding] = useState<any>({ pharmacyName: "TWC Stafford", pharmacyLogo: "", pharmacyIcon: "", version: "" }),
    [updateStatus, setUpdateStatus] = useState<any>({ status: "idle", currentVersion: "…", message: "Loading update status…" }),
    [spotify, setSpotify] = useState<any>({
      connected: false,
      message: "Checking...",
    }),
    [playback, setPlayback] = useState<any>(null),
    [deviceInfo, setDeviceInfo] = useState<{
      computerName: string | null;
      spotifyRunning: boolean | null;
    }>({ computerName: null, spotifyRunning: null }),
    [openingSpotify, setOpeningSpotify] = useState(false),
    [spotifyOpenError, setSpotifyOpenError] = useState(""),
    [playbackError, setPlaybackError] = useState(""),
    [playbackPending, setPlaybackPending] = useState(false),
    [playbackStage, setPlaybackStage] = useState(""),
    [volumeDraft, setVolumeDraft] = useState<number | null>(null),
    [localNow, setLocalNow] = useState(() => new Date()),
    [toast, setToast] = useState(""),
    [modal, setModal] = useState<Schedule | null | false>(false),
    [exceptionModal, setExceptionModal] = useState(false),
    [busy, setBusy] = useState(false),
    [drawerOpen, setDrawerOpen] = useState(false);
  const [announcementBusy, setAnnouncementBusy] = useState(false),
    [announcementAudio, setAnnouncementAudio] =
      useState<HTMLAudioElement | null>(null),
    [announcementScheduleForm, setAnnouncementScheduleForm] = useState<any>({
      id: "",
      name: "",
      days: [] as string[],
      start: "09:00",
      end: "17:00",
      firstAnnouncementId: "",
      secondAnnouncementId: "",
      enabled: true,
    }),
    [announcementDurations, setAnnouncementDurations] = useState<
      Record<string, number>
    >({});
  const announcementPlayback = useRef<{ wasPlaying: boolean; active: boolean }>(
    {
      wasPlaying:
        localStorage.getItem("twc-announcement-window-was-playing") === "1",
      active: false,
    },
  );
  const announcementClaimed = useRef(new Set<string>());
  const announcementLastTick = useRef<Date | null>(null);
  const [googleLocations, setGoogleLocations] = useState<any[]>([]),
    [googleHours, setGoogleHours] = useState<any>(null),
    [googleHoursSource, setGoogleHoursSource] = useState<any>(null),
    [googleBusy, setGoogleBusy] = useState(false),
    [googleImporting, setGoogleImporting] = useState(false),
    [googleResolutions, setGoogleResolutions] = useState<
      Record<string, string>
    >({}),
    [googleError, setGoogleError] = useState(""),
    [googlePreview, setGooglePreview] = useState<any>(null),
    [googleDemo, setGoogleDemoMode] = useState(false),
    [googleConnected, setGoogleConnected] = useState(false);
  const [announcementVolumeDrafts, setAnnouncementVolumeDrafts] = useState<
    Record<string, number>
  >({});
  const [activeTestAnnouncementId, setActiveTestAnnouncementId] = useState<
    string | null
  >(null);
  const [audioManagerSection, setAudioManagerSection] = useState<
    "announcements" | "advertisements"
  >("announcements");
  const [advertisementBusy, setAdvertisementBusy] = useState(false);
  const [advertisementVolumeDrafts, setAdvertisementVolumeDrafts] = useState<
    Record<string, number>
  >({});
  const [advertisementDurations, setAdvertisementDurations] = useState<
    Record<string, number>
  >({});
  const [activeTestAdvertisementId, setActiveTestAdvertisementId] = useState<
    string | null
  >(null);
  const [advertisementScheduleForm, setAdvertisementScheduleForm] =
    useState<any>(newAdvertisementScheduleForm);
  const advertisementAudioRef = useRef<HTMLAudioElement | null>(null);
  const advertisementTestGeneration = useRef(0);
  const advertisementTestBusy = useRef(false);
  const googleImportLock = useRef(false);
  const announcementActionLock = useRef(false);
  const activeAnnouncementAudioRef = useRef<HTMLAudioElement | null>(null);
  const activeAnnouncementIdRef = useRef<string | null>(null);
  const activeAnnouncementModeRef = useRef<"test" | "scheduled" | null>(null);
  const announcementGeneration = useRef(0);
  const announcementPlaybackStateCaptured = useRef(
    localStorage.getItem("twc-announcement-window-was-playing") === "1",
  );
  const canceledTestStartup = useRef(false);
  const spotifyRestorePromise = useRef<Promise<void> | null>(null);
  const playbackSyncVersion = useRef(0);
  const playbackRequestInFlight = useRef(false);
  const playbackActionLock = useRef(false);
  const weeklyCsvInput = useRef<HTMLInputElement>(null);
  const holidayCsvInput = useRef<HTMLInputElement>(null);
  const persist = async (next: any) => {
    setData(next);
    try {
      await window.twc.save(next);
    } catch (e) {
      notify(String(e));
      void window.twc.log(
        "error",
        `Could not save application settings: ${String(e)}`,
      );
    }
  };
  const stopTestAdvertisement = () => {
    advertisementTestGeneration.current++;
    advertisementTestBusy.current = false;
    const audio = advertisementAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
    }
    advertisementAudioRef.current = null;
    setActiveTestAdvertisementId(null);
  };
  const logAdvertisementTest = (level: string, message: string) => {
    void window.twc.log(level, `Advertisement test: ${message}`).catch(() => undefined);
  };
  const testAdvertisement = async (id: string) => {
    if (activeTestAdvertisementId === id) {
      logAdvertisementTest("info", "stopped by user");
      stopTestAdvertisement();
      return;
    }
    stopTestAdvertisement();
    const generation = ++advertisementTestGeneration.current;
    const isCurrent = () => generation === advertisementTestGeneration.current;
    advertisementTestBusy.current = true;
    logAdvertisementTest("info", `button clicked; advertisement ID ${id}`);
    try {
      if (typeof id !== "string" || !/^[\w-]{36}$/.test(id)) {
        throw new Error("The advertisement ID is invalid.");
      }
      if (
        announcementPlayback.current.active ||
        announcementWindowActive(data.announcementSchedules || [], new Date())
      ) {
        notify(
          "Advertisement preview is unavailable during a scheduled announcement.",
        );
        logAdvertisementTest("warn", "blocked because an announcement is active or scheduled");
        return;
      }
      const scheduler = await window.twc.schedulerStatus();
      if (!isCurrent()) return;
      if (scheduler.quiet) {
        logAdvertisementTest("warn", "blocked by Quiet Hours");
        notify("Advertisement preview is blocked during Quiet Hours.");
        return;
      }
      if (spotify.connected) {
        const state = await window.twc.spotifyPlayback();
        if (!isCurrent()) return;
        logAdvertisementTest("info", `Spotify playback checked; playing=${state?.is_playing === true}; device available=${state?.device?.is_usable === true}`);
        if (state?.is_playing) {
          logAdvertisementTest("warn", "blocked because Spotify is playing");
          notify(
            "Advertisement preview is unavailable while Spotify is playing.",
          );
          return;
        }
      }
      const src = await window.twc.advertisementsAudio(id);
      if (!isCurrent()) return;
      const item = (data.advertisements || []).find(
        (advertisement: any) => advertisement.id === id,
      );
      if (!item) throw new Error("The advertisement record was not found in the library.");
      if (!item.enabled) throw new Error("This advertisement is disabled.");
      if (typeof src !== "string" || !/^data:audio\/(mpeg|wav);base64,/.test(src)) throw new Error("The advertisement audio file is empty or has an unsupported format.");
      logAdvertisementTest("info", `record found; enabled=true; audio loaded; format=${src.startsWith("data:audio/wav") ? "wav" : "mp3"}`);
      const audio = new Audio(src);
      audio.volume =
        Math.max(
          0,
          Math.min(
            100,
            Number(advertisementVolumeDrafts[id] ?? item?.volume ?? 100),
          ),
        ) / 100;
      advertisementAudioRef.current = audio;
      setActiveTestAdvertisementId(id);
      audio.onended = () => {
        if (advertisementAudioRef.current === audio) {
          advertisementAudioRef.current = null;
          setActiveTestAdvertisementId(null);
          advertisementTestBusy.current = false;
          logAdvertisementTest("info", `completed; advertisement ID ${id}`);
        }
      };
      audio.onerror = () => {
        if (advertisementAudioRef.current === audio) {
          advertisementAudioRef.current = null;
          setActiveTestAdvertisementId(null);
          advertisementTestBusy.current = false;
        }
        logAdvertisementTest("error", `audio element error; code=${audio.error?.code ?? "unknown"}; message=${audio.error?.message || "unavailable"}`);
        notify(
          "The advertisement preview could not be played. Check that the audio file is valid.",
        );
      };
      await audio.play();
      if (!isCurrent()) return;
      if (audio.paused) throw new Error("The audio player did not enter the playing state.");
      logAdvertisementTest("info", `playback started; advertisement ID ${id}; volume=${Math.round(audio.volume * 100)}%`);
    } catch (error) {
      if (!isCurrent()) return;
      logAdvertisementTest("error", `playback failed; advertisement ID ${id}; ${String(error)}`);
      stopTestAdvertisement();
      notify(
        `Advertisement preview failed: ${String(error).replace(/^Error: /, "")}`,
      );
    } finally {
      if (isCurrent()) advertisementTestBusy.current = false;
    }
  };
  useEffect(() => {
    if (!activeTestAdvertisementId) return;
    let checkInFlight = false;
    const guardQuietHours = () => {
      if (checkInFlight) return;
      checkInFlight = true;
      void window.twc
        .schedulerStatus()
        .then((status) => {
          if (status.quiet && advertisementAudioRef.current) {
            logAdvertisementTest("warn", "preview stopped because Quiet Hours became active");
            stopTestAdvertisement();
            notify("Advertisement preview stopped because Quiet Hours became active.");
          }
        })
        .catch((error) => {
          if (!advertisementAudioRef.current) return;
          logAdvertisementTest("error", `could not verify Quiet Hours; preview stopped fail-safe; ${String(error)}`);
          stopTestAdvertisement();
          notify("Advertisement preview stopped because Quiet Hours could not be verified.");
        })
        .finally(() => { checkInFlight = false; });
    };
    guardQuietHours();
    const timer = window.setInterval(guardQuietHours, 1000);
    return () => window.clearInterval(timer);
  }, [activeTestAdvertisementId]);
  const updateAdvertisement = async (
    id: string,
    patch: Record<string, unknown>,
  ) => {
    const advertisements = (data.advertisements || []).map((item: any) =>
      item.id === id ? { ...item, ...patch } : item,
    );
    await persist({ ...data, advertisements });
  };
  const saveAdSchedule = () => {
    const schedule = {
      ...advertisementScheduleForm,
      id: advertisementScheduleForm.id || crypto.randomUUID(),
      name: advertisementScheduleForm.name.trim(),
    };
    const issue = validateAdvertisementSchedule(schedule);
    if (issue) {
      notify(issue);
      return;
    }
    const availableIds = new Set(
      (data.advertisements || [])
        .filter((item: any) => item.enabled)
        .map((item: any) => item.id),
    );
    if (schedule.advertisementIds.some((id: string) => !availableIds.has(id))) {
      notify("Choose only enabled advertisements from the library.");
      return;
    }
    void persist({
      ...data,
      advertisementSchedules: saveAdvertisementSchedule(
        data.advertisementSchedules || [],
        schedule,
      ),
    });
    setAdvertisementScheduleForm(newAdvertisementScheduleForm());
  };
  useEffect(
    () => () => {
      const audio = advertisementAudioRef.current;
      if (audio) {
        audio.pause();
        audio.src = "";
      }
    },
    [],
  );
  const notify = (s: string) => {
    setToast(s);
    window.setTimeout(() => setToast(""), 4500);
  };
  function restoreSpotifyAfterAnnouncement() {
    const shouldResume = announcementPlayback.current.wasPlaying;
    canceledTestStartup.current = false;
    if (!shouldResume) {
      announcementPlaybackStateCaptured.current = false;
      localStorage.removeItem("twc-announcement-window-was-playing");
      return;
    }
    const generation = announcementGeneration.current;
    let pending: Promise<void>;
    pending = window.twc
      .spotifyControl("play")
      .then(() => {
        if (announcementGeneration.current === generation) {
          announcementPlayback.current.wasPlaying = false;
          announcementPlaybackStateCaptured.current = false;
          localStorage.removeItem("twc-announcement-window-was-playing");
        }
      })
      .catch(() =>
        notify("Announcement finished, but Spotify could not be resumed."),
      )
      .finally(() => {
        if (spotifyRestorePromise.current === pending)
          spotifyRestorePromise.current = null;
      });
    spotifyRestorePromise.current = pending;
  }
  function stopTestAnnouncement() {
    if (activeAnnouncementModeRef.current !== "test") return;
    announcementGeneration.current++;
    const audio = activeAnnouncementAudioRef.current;
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.currentTime = 0;
    }
    activeAnnouncementAudioRef.current = null;
    activeAnnouncementIdRef.current = null;
    activeAnnouncementModeRef.current = null;
    setAnnouncementAudio(null);
    setActiveTestAnnouncementId(null);
    announcementPlayback.current.active = false;
    canceledTestStartup.current = announcementActionLock.current;
    if (!announcementActionLock.current) restoreSpotifyAfterAnnouncement();
  }
  async function playAnnouncement(
    id: string,
    resumeAfter = true,
    preservePrevious = false,
    mode: "test" | "scheduled" = "test",
  ) {
    const previousMode = activeAnnouncementModeRef.current;
    if (
      previousMode === "scheduled" ||
      (mode === "test" &&
        announcementWindowActive(data.announcementSchedules || [], new Date()))
    ) {
      notify(
        previousMode === "scheduled"
          ? "A scheduled announcement is playing."
          : "Testing is unavailable during a scheduled announcement window.",
      );
      return false;
    }
    if (advertisementAudioRef.current) stopTestAdvertisement();
    const pendingRestore = spotifyRestorePromise.current;
    const replacingTest =
      previousMode === "test" ||
      canceledTestStartup.current ||
      !!pendingRestore;
    canceledTestStartup.current = false;
    if (replacingTest && activeAnnouncementAudioRef.current) {
      const previousAudio = activeAnnouncementAudioRef.current;
      previousAudio.onended = null;
      previousAudio.onerror = null;
      previousAudio.pause();
      previousAudio.currentTime = 0;
    }
    const generation = ++announcementGeneration.current;
    announcementActionLock.current = true;
    activeAnnouncementModeRef.current = mode;
    activeAnnouncementAudioRef.current = null;
    activeAnnouncementIdRef.current = id;
    setAnnouncementAudio(null);
    setActiveTestAnnouncementId(mode === "test" ? id : null);
    announcementPlayback.current.active = true;
    const restoreCanceledTest = () => {
      if (
        generation !== announcementGeneration.current &&
        activeAnnouncementModeRef.current === null &&
        !activeAnnouncementAudioRef.current
      ) {
        announcementActionLock.current = false;
        announcementPlayback.current.active = false;
        restoreSpotifyAfterAnnouncement();
      }
    };
    try {
      if (pendingRestore) await pendingRestore;
      if (generation !== announcementGeneration.current) {
        restoreCanceledTest();
        return false;
      }
      if (spotify.connected) {
        const state = await window.twc.spotifyPlayback();
        if (generation !== announcementGeneration.current) {
          restoreCanceledTest();
          return false;
        }
        if (
          !preservePrevious &&
          (!replacingTest || !announcementPlaybackStateCaptured.current)
        ) {
          announcementPlayback.current.wasPlaying = !!state?.is_playing;
          announcementPlaybackStateCaptured.current = true;
          if (announcementPlayback.current.wasPlaying)
            localStorage.setItem("twc-announcement-window-was-playing", "1");
        }
        if (state?.is_playing) await window.twc.spotifyControl("pause");
      }
      if (generation !== announcementGeneration.current) {
        restoreCanceledTest();
        return false;
      }
      const src = await window.twc.announcementsAudio(id);
      if (generation !== announcementGeneration.current) {
        restoreCanceledTest();
        return false;
      }
      const item = (data.announcements || []).find(
        (announcement: any) => announcement.id === id,
      );
      const configuredVolume =
        announcementVolumeDrafts[id] ?? item?.volume ?? 100;
      const audio = new Audio(src);
      audio.volume = Math.max(0, Math.min(100, Number(configuredVolume))) / 100;
      activeAnnouncementAudioRef.current = audio;
      setAnnouncementAudio(audio);
      const finish = (success: boolean) => {
        if (generation !== announcementGeneration.current) return;
        activeAnnouncementAudioRef.current = null;
        activeAnnouncementIdRef.current = null;
        activeAnnouncementModeRef.current = null;
        setAnnouncementAudio(null);
        setActiveTestAnnouncementId(null);
        announcementPlayback.current.active = false;
        announcementActionLock.current = false;
        if (resumeAfter) restoreSpotifyAfterAnnouncement();
        if (!success)
          void window.twc.log(
            "error",
            "Announcement audio failed to play; Spotify remains paused until the scheduled end event.",
          );
      };
      audio.onended = () => finish(true);
      audio.onerror = () => {
        finish(false);
        notify(
          "The announcement could not be played. Check that the audio file is valid.",
        );
      };
      await audio.play();
      if (generation === announcementGeneration.current)
        announcementActionLock.current = false;
      return generation === announcementGeneration.current;
    } catch (error) {
      if (generation !== announcementGeneration.current) {
        restoreCanceledTest();
        return false;
      }
      activeAnnouncementAudioRef.current = null;
      activeAnnouncementIdRef.current = null;
      activeAnnouncementModeRef.current = null;
      setAnnouncementAudio(null);
      setActiveTestAnnouncementId(null);
      announcementPlayback.current.active = false;
      announcementActionLock.current = false;
      if (resumeAfter) restoreSpotifyAfterAnnouncement();
      void window.twc.log(
        "error",
        `Announcement playback failed: ${String(error)}`,
      );
      notify(
        `Announcement playback failed: ${String(error).replace(/^Error: /, "")}`,
      );
      return false;
    }
  }
  async function updateAnnouncement(
    id: string,
    patch: Record<string, unknown>,
  ) {
    const next = {
      ...data,
      announcements: (data.announcements || []).map((item: any) =>
        item.id === id ? { ...item, ...patch } : item,
      ),
    };
    await persist(next);
  }
  useEffect(() => {
    const tick = () => {
      const schedules = data.announcementSchedules || [],
        now = new Date();
      if (
        announcementWindowActive(schedules, now) &&
        !announcementPlayback.current.active
      )
        void window.twc
          .spotifyPlayback()
          .then((state: any) => {
            if (state?.is_playing) {
              announcementPlayback.current.wasPlaying = true;
              return window.twc.spotifyControl("pause");
            }
          })
          .catch(() => undefined);
      const firstMinute = announcementLastTick.current
        ? new Date(
            announcementLastTick.current.getFullYear(),
            announcementLastTick.current.getMonth(),
            announcementLastTick.current.getDate(),
            announcementLastTick.current.getHours(),
            announcementLastTick.current.getMinutes() + 1,
          )
        : now;
      const due: any[] = [];
      for (
        let cursor = firstMinute;
        cursor <= now;
        cursor = new Date(
          cursor.getFullYear(),
          cursor.getMonth(),
          cursor.getDate(),
          cursor.getHours(),
          cursor.getMinutes() + 1,
        )
      )
        due.push(...announcementEventsAt(schedules, cursor));
      announcementLastTick.current = now;
      for (const event of due) {
        if (
          announcementClaimed.current.has(event.key) ||
          localStorage.getItem(`twc-announcement:${event.key}`)
        )
          continue;
        announcementClaimed.current.add(event.key);
        localStorage.setItem(`twc-announcement:${event.key}`, "1");
        const id =
          event.audioId ||
          (event.boundary === "start"
            ? event.schedule.firstAnnouncementId
            : event.schedule.secondAnnouncementId);
        const audio = (data.announcements || []).find(
          (a: any) => a.id === id && a.enabled,
        );
        if (!audio) {
          void window.twc.log(
            "error",
            `Scheduled ${event.boundary} announcement audio is missing or disabled for "${event.schedule.name}".`,
          );
          if (
            event.boundary === "end" &&
            announcementPlayback.current.wasPlaying
          ) {
            void window.twc.spotifyControl("play").catch(() => undefined);
            announcementPlayback.current.wasPlaying = false;
            localStorage.removeItem("twc-announcement-window-was-playing");
          }
          continue;
        }
        if (event.boundary === "end")
          announcementPlayback.current.active = false;
        void playAnnouncement(
          audio.id,
          !!event.custom || event.boundary === "end",
          event.boundary === "end",
          "scheduled",
        );
      }
    };
    const now = new Date();
    if (announcementWindowActive(data.announcementSchedules || [], now)) {
      void window.twc
        .spotifyPlayback()
        .then((state: any) => {
          if (state?.is_playing) {
            announcementPlayback.current.wasPlaying = true;
            return window.twc.spotifyControl("pause");
          }
        })
        .catch(() => undefined);
    } else if (announcementPlayback.current.wasPlaying) {
      void window.twc
        .spotifyControl("play")
        .then(() => {
          announcementPlayback.current.wasPlaying = false;
          localStorage.removeItem("twc-announcement-window-was-playing");
        })
        .catch((error: any) => {
          void window.twc.log(
            "error",
            `Could not recover Spotify after an announcement window: ${String(error)}`,
          );
        });
    }
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [data.announcementSchedules, data.announcements, spotify.connected]);
  useEffect(() => {
    for (const item of data.announcements || [])
      void window.twc
        .announcementsAudio(item.id)
        .then((src) => {
          const audio = new Audio();
          audio.src = src;
          audio.onloadedmetadata = () =>
            setAnnouncementDurations((prev) => ({
              ...prev,
              [item.id]: audio.duration,
            }));
        })
        .catch(() => undefined);
  }, [data.announcements]);
  useEffect(() => {
    for (const item of data.advertisements || [])
      void window.twc
        .advertisementsAudio(item.id)
        .then((src) => {
          const audio = new Audio();
          audio.src = src;
          audio.onloadedmetadata = () =>
            setAdvertisementDurations((prev) => ({
              ...prev,
              [item.id]: audio.duration,
            }));
        })
        .catch(() => undefined);
  }, [data.advertisements]);
  const openSpotifyDesktop = async () => {
    setOpeningSpotify(true);
    setSpotifyOpenError("");
    try {
      await window.twc.openSpotifyDesktop();
      await new Promise((resolve) => window.setTimeout(resolve, 1200));
      const info = await window.twc.deviceInfo();
      setDeviceInfo(info);
      if (info.spotifyRunning === false)
        setSpotifyOpenError(
          "Spotify did not start. Check that the desktop app is installed and try again.",
        );
      else if (info.spotifyRunning === null)
        setSpotifyOpenError(
          "Spotify was opened, but its status could not be checked.",
        );
      if (spotify.connected) {
        try {
          const state = await window.twc.spotifyPlayback();
          setPlayback(state);
          setPlaybackError("");
        } catch (error) {
          setPlayback(null);
          setPlaybackError(String(error).replace(/^Error: /, ""));
        }
      }
    } catch (error) {
      setSpotifyOpenError(String(error).replace(/^Error: /, ""));
    } finally {
      setOpeningSpotify(false);
    }
  };
  useEffect(() => {
    window.twc
      .load()
      .then((d) =>
        setData({
          ...seed,
          ...d,
          settings: { ...seed.settings, ...d.settings },
        }),
      )
      .catch((e) => notify(String(e)));
    window.twc.brandingLoad().then(setBranding).catch(() => undefined);
    window.twc
      .spotifyStatus()
      .then(setSpotify)
      .catch((e) => setSpotify({ connected: false, message: String(e) }));
    void (window.twc as any)
      .googleStatus()
      .then(async (status: any) => {
        setGoogleConnected(!!status.connected);
        if (status.connected) {
          try {
            setGoogleLocations(await (window.twc as any).googleLocations());
          } catch (e) {
            setGoogleError(String(e).replace(/^Error: /, ""));
          }
        }
      })
      .catch(() => undefined);
    const reportRendererError = (event: ErrorEvent) =>
      void window.twc.log("error", `Renderer error: ${event.message}`);
    const reportRejectedPromise = (event: PromiseRejectionEvent) =>
      void window.twc.log(
        "error",
        `Renderer promise failed: ${String(event.reason)}`,
      );
    window.addEventListener("error", reportRendererError);
    window.addEventListener("unhandledrejection", reportRejectedPromise);
    return () => {
      window.removeEventListener("error", reportRendererError);
      window.removeEventListener("unhandledrejection", reportRejectedPromise);
    };
  }, []);
  useEffect(() => window.twc.onSpotifyPlaybackStage(setPlaybackStage), []);
  useEffect(() => {
    const unsubscribe = window.twc.onUpdaterStatus(setUpdateStatus);
    void window.twc.updaterStatus().then(setUpdateStatus).catch(() => undefined);
    return unsubscribe;
  }, []);
  useEffect(() => {
    if (["checking", "current", "available", "downloaded", "error"].includes(updateStatus.status)) notify(updateStatus.message);
    else if (updateStatus.status === "downloading" && updateStatus.percent > 0 && updateStatus.percent % 10 === 0) notify(updateStatus.message);
  }, [updateStatus.status, updateStatus.percent]);
  useEffect(() => {
    let active = true;
    const refreshDeviceInfo = () => {
      void window.twc
        .deviceInfo()
        .then((info) => {
          if (active) setDeviceInfo(info);
        })
        .catch(() => {
          if (active)
            setDeviceInfo({ computerName: null, spotifyRunning: null });
        });
    };
    refreshDeviceInfo();
    const timer = window.setInterval(refreshDeviceInfo, 5000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (page === "Logs")
      void window.twc
        .logsLoad()
        .then((logs) => setData((current: any) => ({ ...current, logs })))
        .catch((e) => notify(String(e)));
  }, [page]);
  const playlists = data.playlists || [];
  const defaultList = playlists.find(
    (p: any) => p.id === data.settings.defaultPlaylist,
  );
  useEffect(() => {
    const interval = Number(data.settings.googleSyncMinutes || 0);
    if (
      !googleConnected ||
      googleDemo ||
      !interval ||
      !data.settings.googleLocation
    )
      return;
    const timer = window.setInterval(() => {
      const last = Date.parse(data.settings.googleLastSync || "");
      if (!Number.isFinite(last) || Date.now() - last >= interval * 60000)
        void googleRefresh();
    }, 60000);
    return () => window.clearInterval(timer);
  }, [
    googleConnected,
    googleDemo,
    data.settings.googleLocation,
    data.settings.googleLastSync,
    data.settings.googleSyncMinutes,
  ]);
  const nextSchedule = useMemo(
    () =>
      data.settings.schedulerEnabled
        ? nextScheduledAction(data.schedules, localNow, data.exceptions || [])
        : null,
    [data.settings.schedulerEnabled, data.schedules, data.exceptions, localNow],
  );
  useEffect(() => {
    let active = true;
    let lastStatusCheck = 0;
    const refresh = async () => {
      setLocalNow(new Date());
      if (!spotify.connected) {
        setPlayback(null);
        return;
      }
      if (Date.now() - lastStatusCheck >= 60000) {
        lastStatusCheck = Date.now();
        void window.twc
          .spotifyStatus()
          .then((status) => {
            if (active) setSpotify(status);
          })
          .catch(() => undefined);
      }
      if (playbackRequestInFlight.current) return;
      playbackRequestInFlight.current = true;
      const version = playbackSyncVersion.current;
      try {
        const state = await window.twc.spotifyPlayback();
        if (active && version === playbackSyncVersion.current) {
          setPlayback(state);
          setPlaybackError("");
        }
      } catch (e) {
        if (active && version === playbackSyncVersion.current) {
          setPlayback(null);
          setPlaybackError(String(e).replace(/^Error: /, ""));
        }
      } finally {
        playbackRequestInFlight.current = false;
      }
    };
    void refresh();
    let timer: number | undefined;
    const scheduleRefresh = () => {
      timer = window.setTimeout(
        async () => {
          await refresh();
          if (active) scheduleRefresh();
        },
        playbackPending ||
          (playbackStage &&
            !["playing", "paused", "playback-failed"].includes(playbackStage))
          ? 1000
          : 10000,
      );
    };
    scheduleRefresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [spotify.connected, data.schedules, playbackPending, playbackStage]);
  async function playbackControl(action: string, value?: number) {
    if (playbackActionLock.current) return;
    if (advertisementAudioRef.current) stopTestAdvertisement();
    playbackActionLock.current = true;
    const version = ++playbackSyncVersion.current;
    setPlaybackPending(true);
    try {
      if (action === "play") {
        setPlaybackError("Playback starting...");
        setPlaybackStage("playback-starting");
      }
      const state = await window.twc.spotifyControl(action, value);
      if (version === playbackSyncVersion.current) {
        setPlayback(state);
        setPlaybackError("");
        setPlaybackStage(state?.is_playing ? "playing" : "paused");
      }
    } catch (e) {
      const message = String(e).replace(/^Error: /, "");
      if (version === playbackSyncVersion.current) setPlaybackError(message);
      notify(message);
      if (/authorization|reconnect/i.test(message))
        void window.twc
          .spotifyStatus()
          .then(setSpotify)
          .catch(() => setSpotify({ connected: false, message }));
    } finally {
      playbackActionLock.current = false;
      setPlaybackPending(false);
    }
  }
  async function commitVolume() {
    if (volumeDraft === null) return;
    const value = volumeDraft;
    setVolumeDraft(null);
    await playbackControl("volume", value);
  }
  async function connect() {
    setBusy(true);
    try {
      const status = await window.twc.spotifyConnect();
      setSpotify(status);
      const ps = await window.twc.playlists();
      const next = { ...data, playlists: ps };
      setData(next);
      await window.twc.save(next);
      notify("Spotify account verified and playlists loaded.");
    } catch (e) {
      notify(String(e));
      void window.twc.log(
        "error",
        `Spotify connection or playlist loading failed: ${String(e)}`,
      );
    } finally {
      setBusy(false);
    }
  }
  async function disconnect() {
    try {
      const status = await window.twc.spotifyDisconnect();
      setSpotify(status);
      setPlayback(null);
      setPlaybackError("");
      notify(status.message);
    } catch (e) {
      notify(String(e));
    }
  }
  async function refreshPlaylists() {
    try {
      const ps = await window.twc.playlists();
      const next = { ...data, playlists: ps };
      await persist(next);
      notify(`Loaded ${ps.length} playlists from Spotify.`);
    } catch (e) {
      notify(String(e));
      void window.twc.log("error", `Playlist refresh failed: ${String(e)}`);
    }
  }
  async function audioTest() {
    try {
      const scheduler = await window.twc.schedulerStatus();
      if (scheduler.quiet) {
        notify("Audio test blocked during an active quiet-hours schedule.");
        return;
      }
      if (spotify.connected) {
        const current = await window.twc.spotifyPlayback();
        if (current?.is_playing) {
          notify(
            "Pause Spotify playback before running the audio output test.",
          );
          return;
        }
      }
      const context = new AudioContext();
      await context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.value = 440;
      gain.gain.value = 0.08;
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.65);
      await new Promise((resolve) => (oscillator.onended = resolve));
      await context.close();
      notify(
        "Test tone was sent to the Windows default audio output. Confirm that you can hear it.",
      );
      void window.twc.log(
        "info",
        "Audio test tone sent to the default audio output.",
      );
    } catch (e) {
      const message = `Audio test failed: ${String(e).replace(/^Error: /, "")}`;
      notify(message);
      void window.twc.log("error", message);
    }
  }
  async function googleConnect() {
    setGoogleBusy(true);
    setGoogleError("");
    setGoogleDemoMode(false);
    setGoogleHoursSource(null);
    setGoogleHours(null);
    setGooglePreview(null);
    try {
      await (window.twc as any).googleConnect();
      setGoogleConnected(true);
      const locations = await (window.twc as any).googleLocations();
      setGoogleLocations(locations);
      notify(`Loaded ${locations.length} Business Profile locations.`);
    } catch (e) {
      setGoogleError(String(e).replace(/^Error: /, ""));
    } finally {
      setGoogleBusy(false);
    }
  }
  async function googleImportDesktopClient() {
    setGoogleBusy(true);
    setGoogleError("");
    try {
      const result = await (window.twc as any).googleImportDesktopClient();
      if (result.imported)
        notify(
          "Optional Desktop OAuth client credentials were encrypted in system storage. Connect Google again to retry authorization.",
        );
    } catch (e) {
      setGoogleError(String(e).replace(/^Error: /, ""));
    } finally {
      setGoogleBusy(false);
    }
  }
  async function googleRefresh() {
    setGoogleBusy(true);
    setGoogleError("");
    try {
      const location = googleLocations.find(
        (x) => x.name === data.settings.googleLocation,
      );
      if (!location)
        throw new Error("Select a Business Profile location first.");
      const fetched = await (window.twc as any).googleHours(location.name);
      setGoogleHours(parseBusinessHours(fetched));
      setGoogleHoursSource(null);
      setGoogleDemoMode(false);
      const next = {
        ...data,
        settings: {
          ...data.settings,
          googleLastSync: new Date().toISOString(),
          googleLocationTitle: fetched.title || location.title,
        },
      };
      await persist(next);
    } catch (e) {
      setGoogleError(String(e).replace(/^Error: /, ""));
    } finally {
      setGoogleBusy(false);
    }
  }
  function setGoogleDemo() {
    setGoogleDemoMode(true);
    setGoogleConnected(false);
    setGoogleHoursSource({
      id: "demo",
      title: demoBusinessHours.name,
      kind: "demo",
    });
    setGoogleLocations([{ name: "demo", title: demoBusinessHours.name }]);
    setGoogleHours(parseBusinessHours(demoBusinessHours));
    setGooglePreview(null);
    setGoogleError("");
  }
  async function importBusinessHoursCsv(
    event: any,
    expectedKind: "weekly" | "holidays",
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024)
        throw new Error("CSV file must be smaller than 5 MB.");
      const hours = parseBusinessHoursCsv(await file.text());
      if (expectedKind === "weekly" && hours.special.length)
        throw new Error(
          "This file contains holiday exception rows. Choose Upload Holiday Exceptions CSV instead.",
        );
      if (expectedKind === "holidays" && !hours.special.length)
        throw new Error(
          "No holiday exception rows were found. Choose Upload Weekly Hours CSV for recurring hours.",
        );
      const title = file.name.replace(/\.csv$/i, "") || "Business hours CSV";
      const id =
        title
          .toLowerCase()
          .normalize("NFKD")
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 80) || "hours-file";
      setGoogleHours(hours);
      setGoogleHoursSource({ id, title: `CSV  |  ${title}`, kind: "csv" });
      setGoogleDemoMode(false);
      setGooglePreview(null);
      setGoogleError("");
      notify(
        `Loaded ${file.name}. Review the business hours and import preview.`,
      );
    } catch (e) {
      setGoogleError(String(e).replace(/^Error: /, ""));
    }
  }
  function previewGoogleImport() {
    try {
      const location = googleHoursSource
        ? { name: googleHoursSource.id, title: googleHoursSource.title }
        : googleLocations.find(
            (x) => x.name === data.settings.googleLocation,
          ) || googleLocations[0];
      const result = importHoursAsSchedules(googleHours, {
        playlistId: data.settings.defaultPlaylist,
        playlistName:
          playlists.find((p: any) => p.id === data.settings.defaultPlaylist)
            ?.name || "",
        existing: data.schedules,
        existingExceptions: data.exceptions,
        locationName: location?.title,
        locationId: location?.name || "demo",
        sourceType: googleHoursSource?.kind === "csv" ? "csv" : "google",
      });
      const replaceIds = new Set(result.replacements);
      result.conflicts = result.schedules.flatMap((candidate: any) =>
        data.schedules.flatMap((existing: any) => {
          if (replaceIds.has(existing.id)) return [];
          if (!candidate.dates) {
            if (existing.dates) return [];
            return candidate.days
              .filter(
                (day: string) =>
                  existing.days?.includes(day) &&
                  schedulesConflict(
                    { ...candidate, days: [day] },
                    { ...existing, days: [day] },
                  ),
              )
              .map((day: string) => ({
                id: `${candidate.googleSourceId}|${existing.id}|${day}`,
                sourceId: candidate.googleSourceId,
                existingId: existing.id,
                location: location?.title || "Business Profile",
                day,
                candidate,
                existing,
              }));
          }
          return candidate.dates.flatMap((date: string) => {
            if (existing.dates && !existing.dates.includes(date)) return [];
            const atNoon = new Date(`${date}T12:00:00`);
            const weekday = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][
              atNoon.getDay()
            ];
            return existing.days?.includes(weekday) &&
              schedulesConflict(
                { ...candidate, days: [weekday] },
                { ...existing, days: [weekday] },
              )
              ? [
                  {
                    id: `${candidate.googleSourceId}|${existing.id}|${date}`,
                    sourceId: candidate.googleSourceId,
                    existingId: existing.id,
                    location: location?.title || "Business Profile",
                    day: date,
                    candidate,
                    existing,
                  },
                ]
              : [];
          });
        }),
      );
      setGoogleResolutions({});
      setGooglePreview(result);
    } catch (e) {
      setGoogleError(String(e).replace(/^Error: /, ""));
    }
  }
  async function applyGoogleImport() {
    if (
      !googlePreview ||
      googleImportLock.current ||
      googlePreview.conflicts.some((x: any) => !googleResolutions[x.id])
    )
      return;
    googleImportLock.current = true;
    setGoogleImporting(true);
    setGoogleError("");
    try {
      const resolved = resolveGoogleImportPlan(
        googlePreview,
        data.schedules,
        data.exceptions,
        googlePreview.conflicts,
        googleResolutions,
      );
      const next = {
        ...data,
        schedules: resolved.schedules,
        exceptions: resolved.exceptions,
      };
      await window.twc.save(next);
      setData(next);
      setGooglePreview(null);
      notify(
        `Applied ${resolved.acceptedCount} music periods and ${resolved.exceptionCount} holiday overrides. ${resolved.skippedCount} periods kept existing schedules.`,
      );
    } catch (e) {
      setGoogleError(
        `Could not apply schedule changes: ${String(e).replace(/^Error: /, "")}`,
      );
    } finally {
      googleImportLock.current = false;
      setGoogleImporting(false);
    }
  }
  function updateSetting(key: string, value: any) {
    persist({ ...data, settings: { ...data.settings, [key]: value } });
  }
  async function uploadBrandAsset(kind: "logo" | "icon") {
    try {
      const picked = await window.twc.brandingUpload(kind);
      if (!picked) return;
      if (kind === "logo" && picked.name && picked.dataUrl) {
        setBranding((current: any) => ({ ...current, pharmacyLogo: picked.name, pharmacyLogoPreview: picked.dataUrl }));
        return;
      }
      if (kind === "icon" && picked.sourceDataUrl) {
        const image = new Image();
        image.src = picked.sourceDataUrl;
        await image.decode();
        if (image.naturalWidth > 12000 || image.naturalHeight > 12000 || image.naturalWidth * image.naturalHeight > 40000000) throw new Error("This image is too large to process safely. Choose an image under 40 megapixels.");
        const variants: Record<number, string> = {};
        for (const size of [256, 128, 64, 32]) {
          const canvas = document.createElement("canvas");
          canvas.width = size;
          canvas.height = size;
          const context = canvas.getContext("2d");
          if (!context) throw new Error("Icon image processing is unavailable.");
          context.clearRect(0, 0, size, size);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = "high";
          const scale = Math.min(size / image.naturalWidth, size / image.naturalHeight);
          const width = image.naturalWidth * scale;
          const height = image.naturalHeight * scale;
          context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height);
          variants[size] = canvas.toDataURL("image/png").split(",")[1];
        }
        const saved = await window.twc.brandingStoreIcon(variants);
        setBranding((current: any) => ({ ...current, pharmacyIcon: saved.name, pharmacyIconPreview: saved.previews[256], pharmacyIconSizes: { 128: saved.previews[128], 64: saved.previews[64], 32: saved.previews[32] } }));
      }
    } catch (error) { notify(String(error).replace(/^Error: /, "")); }
  }
  function saveSchedule(s: Schedule) {
    const arr = [...data.schedules];
    const i = arr.findIndex((x: Schedule) => x.id === s.id);
    if (i >= 0) arr[i] = s;
    else arr.push(s);
    persist({ ...data, schedules: arr });
    void window.twc.log(
      "info",
      `${i >= 0 ? "Updated" : "Created"} schedule ${s.name}`,
    );
    setModal(false);
  }
  function removeSchedule(s: Schedule) {
    if (window.confirm(`Delete "${s.name}"?`)) {
      persist({
        ...data,
        schedules: data.schedules.filter((x: Schedule) => x.id !== s.id),
      });
      void window.twc.log("info", `Deleted schedule ${s.name}`);
    }
  }
  const actions = [
    {
      label: "Manage Schedule",
      sub: "Edit playback times, playlists and Quiet Hour actions",
      icon: CalendarDays,
      color: "blue",
      go: () => setPage("Schedule"),
    },
    {
      label: "Test Spotify",
      sub: spotify.connected
        ? "Refresh your Spotify account"
        : "Connect or verify your Spotify account",
      icon: Music2,
      color: "green",
      go: () => (spotify.connected ? refreshPlaylists() : connect()),
    },
    {
      label: "Test Audio",
      sub: "Check your audio output",
      icon: Volume2,
      color: "purple",
      go: audioTest,
    },
    {
      label: "Settings",
      sub: "Adjust app settings",
      icon: SettingsIcon,
      color: "gray",
      go: () => setPage("Settings"),
    },
  ];
  return (
    <div className="window">
      <header className="titlebar">
        <button
          className="title-menu icon-wrapper"
          aria-label="Open navigation"
          onClick={() => setDrawerOpen(!drawerOpen)}
        >
          <Menu />
        </button>

        <img
          alt={`${branding.pharmacyName} application icon`}
          className="app-title-icon"
          src={branding.pharmacyIconSizes?.[32] || branding.pharmacyIconPreview || "./icons/app-icon.ico"}
        />

        <span className="title-text">{branding.pharmacyName} Music Scheduler</span>

        <div className="window-controls">
          <button
            aria-label="Minimize"
            onClick={() => window.twc.windowAction("minimize")}
          >
            <Minus size={15} aria-hidden="true" />
          </button>

          <button
            aria-label="Maximize"
            onClick={() => window.twc.windowAction("maximize")}
          >
            <Square size={13} aria-hidden="true" />
          </button>

          <button
            aria-label="Close"
            onClick={() => window.twc.windowAction("close")}
          >
            <X size={15} aria-hidden="true" />
          </button>
        </div>
      </header>
      {drawerOpen && (
        <button
          className="drawer-scrim"
          aria-label="Close navigation"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      <aside className={`sidebar ${drawerOpen ? "drawer-open" : ""}`}>
        <div className="brand">
          {branding.pharmacyLogoPreview ? <img className="brand-image" src={branding.pharmacyLogoPreview} alt={`${branding.pharmacyName} logo`} /> : <BrandAsset variant="logo" />}
        </div>
        <nav>
          {nav.map(({ name, icon: Icon }) => (
            <button
              key={name}
              onClick={() => {
                setPage(name);
                setDrawerOpen(false);
              }}
              className={`nav-item ${page === name ? "active" : ""}`}
            >
              <span className="nav-icon icon-wrapper">
                <Icon />
              </span>
              <span>{name}</span>
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <div className="wave" aria-hidden="true">
            <img src="./wave.png" alt="" />
          </div>
          <span>Music for a better space.</span>
        </div>
      </aside>
      <main className="main" spellCheck={true}>
        <div className="content">
          {page === "Home" && (
            <>
              <section className="welcome">
                <div>
                  <div className="eyebrow">Welcome to</div>
                  {branding.pharmacyLogoPreview && <img className="welcome-brand-image" src={branding.pharmacyLogoPreview} alt={`${branding.pharmacyName} logo`} />}
                  <h1>{branding.pharmacyName}</h1>
                  <p>Music scheduler</p>
                </div>
                <button
                  className="connection"
                  onClick={() => setPage("Settings")}
                >
                  <Circle
                    size={18}
                    fill={spotify.connected ? "#13bd57" : "#ef4444"}
                    color={spotify.connected ? "#13bd57" : "#ef4444"}
                  />
                  <div>
                    <b>{spotify.connected ? "Connected" : "Not connected"}</b>
                    <span>
                      {spotify.connected
                        ? `Spotify account  |  ${spotify.name}`
                        : spotify.message}
                    </span>
                  </div>
                  <img
                    src="./spotify.png"
                    alt="Spotify"
                    className="spotify-mark"
                  />
                  <ChevronRight color="#8190a8" />
                </button>
              </section>
              <section className="status-card">
                <div className="status-unit">
                  <label>CURRENT STATUS</label>
                  <div className="status-line">
                    <span className="round-icon">
                      <Play fill="currentColor" />
                    </span>
                    <div>
                      <b>
                        {playback?.is_playing
                          ? "Playing"
                          : playbackPending
                            ? (
                                {
                                  "transfer-requested": "Transfer requested",
                                  "device-switching": "Device switching",
                                  "playback-starting": "Playback starting",
                                } as any
                              )[playbackStage] || "Playback starting"
                            : playbackStage === "playback-failed"
                              ? "Playback failed"
                              : playback?.device?.is_active
                                ? "Paused"
                                : playback?.device?.is_usable
                                  ? "Ready"
                                  : spotify.connected
                                    ? "Unavailable"
                                    : "Disconnected"}
                      </b>
                      <span>
                        {playback?.item
                          ? `${playback.item.name}  |  ${playback.item.artists?.map((a: any) => a.name).join(", ")}`
                          : playbackError ||
                            (playback?.device?.is_usable
                              ? `Ready on ${playback.device.name}`
                              : spotify.connected
                                ? "Waiting for an available Spotify playback device"
                                : "Connect Spotify to control playback")}
                      </span>
                    </div>
                  </div>
                </div>
                <div className="status-unit">
                  <label>PLAYBACK DEVICE</label>
                  <div className="status-line">
                    <span className="square-icon">
                      <Monitor size={29} />
                    </span>
                    <div>
                      <b>
                        {deviceInfo.computerName || "Computer name unavailable"}
                      </b>
                      <div className="spotify-container">
                        <span className="spotify-process-status">
                          {deviceInfo.spotifyRunning === null ? (
                            "Status unavailable."
                          ) : (
                            <>
                              <i
                                className={
                                  deviceInfo.spotifyRunning
                                    ? "spotify-status-dot is-open"
                                    : "spotify-status-dot is-closed"
                                }
                                aria-hidden="true"
                              />
                              Spotify is{" "}
                              {deviceInfo.spotifyRunning ? "Open" : "Closed"}
                            </>
                          )}
                        </span>
                        {deviceInfo.spotifyRunning === false && (
                          <button
                            type="button"
                            className="spotify-open-button"
                            onClick={() => void openSpotifyDesktop()}
                            disabled={openingSpotify}
                          >
                            {openingSpotify ? "Opening..." : "Open Spotify"}
                          </button>
                        )}
                      </div>
                      {spotifyOpenError && (
                        <span className="spotify-open-error" role="status">
                          {spotifyOpenError}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="status-unit">
                  <label>NEXT SCHEDULED ACTION</label>
                  <div className="status-line">
                    <span className="square-icon blue-icon">
                      <CalendarDays size={28} />
                    </span>
                    <div>
                      <b>
                        {nextSchedule
                          ? formatLocalDateTime(nextSchedule.at)
                          : data.settings.schedulerEnabled
                            ? "No upcoming scheduled action"
                            : "Scheduler disabled"}
                      </b>
                      <span>
                        {nextSchedule
                          ? `${nextSchedule.schedule.name}  |  ${nextSchedule.boundary}${nextSchedule.exception?.type === "replace" ? "  |  date replacement" : ""}`
                          : data.settings.schedulerEnabled
                            ? "Configure a schedule to get started"
                            : "Enable the scheduler in Settings to run actions"}
                      </span>
                    </div>
                  </div>
                </div>
              </section>
              <section
                className="playback-controls"
                aria-label="Spotify playback controls"
              >
                <div className="playback-buttons">
                  <button
                    className="icon-btn"
                    aria-label="Previous track"
                    title="Previous track"
                    disabled={
                      !playback?.device?.is_usable ||
                      playback?.device?.is_restricted ||
                      !!playback?.actions?.disallows?.skipping_prev ||
                      playback?.actions?.skipping_prev === false
                    }
                    onClick={() => void playbackControl("previous")}
                  >
                    <SkipBack />
                  </button>
                  <button
                    className="play-toggle"
                    aria-label={playback?.is_playing ? "Pause" : "Play"}
                    disabled={
                      playbackPending ||
                      !playback?.device?.is_usable ||
                      playback?.device?.is_restricted ||
                      !!playback?.actions?.disallows?.[
                        playback?.is_playing ? "pausing" : "resuming"
                      ] ||
                      playback?.actions?.[
                        playback?.is_playing ? "pausing" : "resuming"
                      ] === false
                    }
                    onClick={() =>
                      void playbackControl(
                        playback?.is_playing ? "pause" : "play",
                      )
                    }
                  >
                    {playback?.is_playing ? (
                      <Pause fill="currentColor" />
                    ) : (
                      <Play fill="currentColor" />
                    )}
                  </button>
                  <button
                    className="icon-btn"
                    aria-label="Next track"
                    title="Next track"
                    disabled={
                      !playback?.device?.is_usable ||
                      playback?.device?.is_restricted ||
                      !!playback?.actions?.disallows?.skipping_next ||
                      playback?.actions?.skipping_next === false
                    }
                    onClick={() => void playbackControl("next")}
                  >
                    <SkipForward />
                  </button>
                </div>
                <div className="volume-control">
                  <Volume2 size={20} />
                  <input
                    aria-label="Spotify volume"
                    type="range"
                    min="0"
                    max="100"
                    value={volumeDraft ?? playback?.device?.volume_percent ?? 0}
                    disabled={
                      !playback?.device?.is_usable ||
                      !playback?.device?.supports_volume
                    }
                    onChange={(e) => setVolumeDraft(Number(e.target.value))}
                    onPointerUp={() => void commitVolume()}
                    onKeyUp={() => void commitVolume()}
                  />
                  <b>{playback?.device?.volume_percent ?? "-"}%</b>
                </div>
                <span className="playback-note">
                  {playback?.device?.supports_volume === false
                    ? "Volume control unavailable on this device"
                    : playbackError ||
                      (playback?.device?.is_usable
                        ? playback.device.is_active
                          ? `Playback ${playback.is_playing ? "playing" : "paused"}  |  ${playback.device.name}`
                          : `Ready to play on ${playback.device.name}`
                        : spotify.connected
                          ? "Waiting for Spotify to provide an available playback device"
                          : "Connect Spotify to control playback")}
                </span>
              </section>
              <section className="playlist-row">
                <InfoCard
                  icon={Music2}
                  label="DEFAULT PLAYLIST"
                  title={defaultList?.name || "No playlist selected"}
                  detail={
                    defaultList
                      ? `${defaultList.tracks} tracks`
                      : "Choose in Settings"
                  }
                  onClick={() => setPage("Playlists")}
                />
                <InfoCard
                  icon={ListMusic}
                  label="TODAY'S PLAYLIST / EXCEPTION"
                  title={defaultList?.name || "No playlist assigned"}
                  detail="No exception set"
                  onClick={() => setPage("Schedule")}
                />
              </section>
              <section className="actions">
                {actions.map((a) => (
                  <button
                    className={`action ${a.color}`}
                    key={a.label}
                    onClick={a.go}
                  >
                    <span className="action-icon icon-wrapper">
                      <a.icon
                        fill={a.color === "green" ? "currentColor" : "none"}
                      />
                    </span>
                    <span className="action-copy">
                      <b>{a.label}</b>
                      <span>{a.sub}</span>
                    </span>
                    <ChevronRight className="action-chevron" />
                  </button>
                ))}
              </section>
              {/* <section className="secondary-actions">
                <button className="outline" onClick={() => setPage("Schedule")}>
                  <Moon size={22} />
                  Test Full Quiet Hour
                </button>
                <button className="log-link" onClick={() => setPage("Logs")}>
                  <ScrollText size={20} />
                  View logs
                </button>
              </section> */}
            </>
          )}
          {page === "Schedule" && (
            <>
              <PageHeading
                title="Schedule"
                sub="Set recurring music times, quiet hours and date exceptions."
                action={
                  <button className="primary" onClick={() => setModal(null)}>
                    <Plus size={19} />
                    Add schedule
                  </button>
                }
              />
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <b>Scheduled actions</b>
                    <span>
                      Schedule actions run in local PC time while this app is
                      open and Spotify has an available device.
                    </span>
                  </div>
                  <label className="toggle-label">
                    <input
                      type="checkbox"
                      checked={!!data.settings.schedulerEnabled}
                      onChange={(e) =>
                        updateSetting("schedulerEnabled", e.target.checked)
                      }
                    />{" "}
                    Scheduler enabled
                  </label>
                </div>
                {data.schedules.length === 0 ? (
                  <Empty
                    title="No schedules yet"
                    text="Add a schedule to define when music or quiet hours should run."
                  />
                ) : (
                  <div className="schedule-list">
                    {data.schedules.map((s: Schedule) => (
                      <div className="schedule-row" key={s.id}>
                        <div className="schedule-time">
                          <b>
                            {s.start} - {s.end}
                          </b>
                          <span>
                            {s.date
                              ? `${s.date}  |  ${(s.repeat || "never").replace(/^./, (x) => x.toUpperCase())}`
                              : s.days.join("  |  ") || "No days selected"}
                          </span>
                        </div>
                        <div className="schedule-name">
                          <b>{s.name}</b>
                          <span>
                            {s.quiet
                              ? "Quiet hours"
                              : s.playlistName || "No playlist assigned"}
                            {s.enabled ? "" : "  |  Paused"}
                          </span>
                        </div>
                        <button
                          className="icon-btn"
                          aria-label="Edit"
                          onClick={() => setModal(s)}
                        >
                          <Pencil size={18} />
                        </button>
                        <button
                          className="icon-btn danger"
                          aria-label="Delete"
                          onClick={() => removeSchedule(s)}
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div className="panel">
                <div className="panel-head">
                  <div>
                    <b>Date exceptions</b>
                    <span>
                      Override the regular schedule on a specific date.
                    </span>
                  </div>
                  <button
                    className="subtle"
                    onClick={() => setExceptionModal(true)}
                  >
                    <Plus size={17} />
                    Add exception
                  </button>
                </div>
                {data.exceptions?.length ? (
                  <div className="schedule-list">
                    {data.exceptions.map((x: any, i: number) => (
                      <div className="schedule-row" key={i}>
                        <b>{x.date}</b>
                        <span className="grow">
                          {x.type === "replace"
                            ? `Replace with ${x.playlistName || playlists.find((p: any) => p.id === x.playlistId)?.name || "selected playlist"}`
                            : "Skip scheduled playback"}
                          {x.label ? `  |  ${x.label}` : ""}
                        </span>
                        <button
                          className="icon-btn danger"
                          onClick={() => {
                            if (confirm("Delete this exception?"))
                              persist({
                                ...data,
                                exceptions: data.exceptions.filter(
                                  (_: any, j: number) => i !== j,
                                ),
                              });
                          }}
                        >
                          <Trash2 size={18} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title="No exceptions"
                    text="Special dates can use a different playlist or pause scheduled music."
                  />
                )}
              </div>
            </>
          )}
          {page === "Playlists" && (
            <>
              <PageHeading
                title="Playlists"
                sub="Playlists are read from your authorized Spotify account."
                action={
                  <button className="primary" onClick={refreshPlaylists}>
                    <RefreshCw size={18} />
                    Refresh playlists
                  </button>
                }
              />
              {!spotify.connected ? (
                <div className="panel">
                  <Empty
                    title="Spotify is not connected"
                    text="Connect your account in Settings to load your playlists."
                  />
                  <button
                    className="primary center-button"
                    onClick={() => setPage("Settings")}
                  >
                    Open Settings
                  </button>
                </div>
              ) : playlists.length === 0 ? (
                <div className="panel">
                  <Empty
                    title="No playlists loaded"
                    text="Refresh to fetch your Spotify playlists."
                  />
                  <button
                    className="primary center-button"
                    onClick={refreshPlaylists}
                  >
                    Load playlists
                  </button>
                </div>
              ) : (
                <div className="playlist-grid">
                  {playlists.map((p: any) => (
                    <div className="playlist-card" key={p.id}>
                      {p.image ? (
                        <img
                          className="playlist-art"
                          src={p.image}
                          alt=""
                          onError={(e) => {
                            e.currentTarget.classList.add(
                              "playlist-art-failed",
                            );
                          }}
                        />
                      ) : null}

                      <span className="playlist-art-fallback">
                        <Music2 size={24} />
                      </span>

                      <div className="grow">
                        <b>{p.name}</b>
                        <span>{p.tracks} tracks</span>
                      </div>

                      <button
                        className={
                          data.settings.defaultPlaylist === p.id
                            ? "selected-pill"
                            : "subtle"
                        }
                        onClick={() => updateSetting("defaultPlaylist", p.id)}
                      >
                        {data.settings.defaultPlaylist === p.id
                          ? "Default"
                          : "Set default"}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {page === "Audio Manager" && (
            <>
              <PageHeading
                title="Audio Manager"
                sub="Manage scheduled announcements and advertisement audio."
              />
              <div
                className="audio-manager-tabs"
                role="tablist"
                aria-label="Audio Manager sections"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={audioManagerSection === "announcements"}
                  className={
                    audioManagerSection === "announcements" ? "active" : ""
                  }
                  onClick={() => setAudioManagerSection("announcements")}
                >
                  Announcements
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={audioManagerSection === "advertisements"}
                  className={
                    audioManagerSection === "advertisements" ? "active" : ""
                  }
                  onClick={() => setAudioManagerSection("advertisements")}
                >
                  Advertisements
                </button>
              </div>
              {audioManagerSection === "announcements" && (
                <>
                  <PageHeading
                    title="Announcements"
                    sub="Import and schedule local audio announcements."
                    action={
                      <button
                        className="primary"
                        disabled={announcementBusy}
                        onClick={async () => {
                          setAnnouncementBusy(true);
                          try {
                            const added =
                              await window.twc.announcementsImport();
                            if (added.length)
                              await persist({
                                ...data,
                                announcements: [
                                  ...(data.announcements || []),
                                  ...added,
                                ],
                              });
                          } catch (e) {
                            notify(String(e));
                          } finally {
                            setAnnouncementBusy(false);
                          }
                        }}
                      >
                        <Plus size={18} />
                        Import audio
                      </button>
                    }
                  />
                  <div className="panel">
                    <h3>Announcement library</h3>
                    {(data.announcements || []).length ? (
                      <div className="schedule-list">
                        {data.announcements.map((a: any) => (
                          <div className="schedule-row" key={a.id}>
                            <div className="schedule-name">
                              <b>{a.name}</b>
                              <span>
                                {announcementDurations[a.id]
                                  ? `${Math.floor(announcementDurations[a.id] / 60)}:${String(Math.floor(announcementDurations[a.id] % 60)).padStart(2, "0")}`
                                  : "Duration unavailable"}
                              </span>
                              <label>
                                Volume{" "}
                                {announcementVolumeDrafts[a.id] ??
                                  a.volume ??
                                  100}
                                %
                                <input
                                  aria-label={`${a.name} announcement volume`}
                                  type="range"
                                  min="0"
                                  max="100"
                                  value={
                                    announcementVolumeDrafts[a.id] ??
                                    a.volume ??
                                    100
                                  }
                                  onChange={(e) => {
                                    const volume = Number(e.target.value);
                                    setAnnouncementVolumeDrafts((current) => ({
                                      ...current,
                                      [a.id]: volume,
                                    }));
                                    if (
                                      activeAnnouncementModeRef.current ===
                                        "test" &&
                                      activeAnnouncementIdRef.current ===
                                        a.id &&
                                      activeAnnouncementAudioRef.current
                                    )
                                      activeAnnouncementAudioRef.current.volume =
                                        volume / 100;
                                  }}
                                  onPointerUp={(e) =>
                                    void updateAnnouncement(a.id, {
                                      volume: Number(e.currentTarget.value),
                                    })
                                  }
                                  onKeyUp={(e) =>
                                    void updateAnnouncement(a.id, {
                                      volume: Number(e.currentTarget.value),
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <label className="toggle-label">
                              <input
                                type="checkbox"
                                checked={a.enabled}
                                onChange={(e) =>
                                  void updateAnnouncement(a.id, {
                                    enabled: e.target.checked,
                                  })
                                }
                              />
                              Enabled
                            </label>
                            <button
                              className="icon-btn"
                              aria-label="Edit announcement name"
                              onClick={() => {
                                const name = window.prompt(
                                  "Announcement name",
                                  a.name,
                                );
                                if (name?.trim())
                                  void updateAnnouncement(a.id, {
                                    name: name.trim(),
                                  });
                              }}
                            >
                              <Pencil size={17} />
                            </button>
                            {activeTestAnnouncementId === a.id ? (
                              <button
                                className="subtle"
                                onClick={stopTestAnnouncement}
                              >
                                Stop Test
                              </button>
                            ) : (
                              <button
                                className="subtle"
                                onClick={() => void playAnnouncement(a.id)}
                              >
                                {" "}
                                <Play size={16} />
                                Test Announcement
                              </button>
                            )}
                            <button
                              className="icon-btn"
                              aria-label="Delete announcement"
                              onClick={async () => {
                                if (!confirm(`Delete ${a.name}?`)) return;
                                try {
                                  await window.twc.announcementsDeleteFile(
                                    a.id,
                                  );
                                  await persist({
                                    ...data,
                                    announcements: data.announcements.filter(
                                      (x: any) => x.id !== a.id,
                                    ),
                                    announcementSchedules:
                                      data.announcementSchedules,
                                  });
                                } catch (e) {
                                  notify(String(e));
                                }
                              }}
                            >
                              <Trash2 />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        title="No announcements imported"
                        text="Import MP3 or WAV audio to get started."
                      />
                    )}
                  </div>
                  <div className="panel form-panel">
                    <h3>
                      {announcementScheduleForm.id
                        ? "Edit announcement schedule"
                        : "Create announcement schedule"}
                    </h3>
                    <label>
                      Schedule name
                      <input
                        value={announcementScheduleForm.name}
                        onChange={(e) =>
                          setAnnouncementScheduleForm({
                            ...announcementScheduleForm,
                            name: e.target.value,
                          })
                        }
                        placeholder="Remembrance Day"
                        maxLength={80}
                      />
                    </label>
                    <label>
                      Schedule type
                      <select
                        value={
                          announcementScheduleForm.date ? "date" : "weekly"
                        }
                        onChange={(e) => {
                          if (e.target.value === "date") {
                            const today = new Date();
                            setAnnouncementScheduleForm({
                              ...announcementScheduleForm,
                              days: [],
                              date: `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`,
                              time: "10:58",
                              repeat: "never",
                              announcementId: "",
                            });
                          } else
                            setAnnouncementScheduleForm({
                              ...announcementScheduleForm,
                              date: undefined,
                              time: undefined,
                              repeat: undefined,
                              announcementId: undefined,
                              days: [],
                            });
                        }}
                      >
                        <option value="weekly">Weekly schedule</option>
                        <option value="date">Specific date announcement</option>
                      </select>
                    </label>
                    {announcementScheduleForm.date ? (
                      <div className="two-fields">
                        <label>
                          Date
                          <input
                            type="date"
                            value={announcementScheduleForm.date}
                            onChange={(e) =>
                              setAnnouncementScheduleForm({
                                ...announcementScheduleForm,
                                date: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Time
                          <input
                            type="time"
                            value={announcementScheduleForm.time || "10:58"}
                            onChange={(e) =>
                              setAnnouncementScheduleForm({
                                ...announcementScheduleForm,
                                time: e.target.value,
                              })
                            }
                          />
                        </label>
                        <label>
                          Repeat
                          <select
                            value={announcementScheduleForm.repeat || "never"}
                            onChange={(e) =>
                              setAnnouncementScheduleForm({
                                ...announcementScheduleForm,
                                repeat: e.target.value,
                              })
                            }
                          >
                            <option value="never">Never</option>
                            <option value="yearly">Yearly</option>
                          </select>
                        </label>
                        <label>
                          Announcement audio
                          <select
                            value={
                              announcementScheduleForm.announcementId || ""
                            }
                            onChange={(e) =>
                              setAnnouncementScheduleForm({
                                ...announcementScheduleForm,
                                announcementId: e.target.value,
                              })
                            }
                          >
                            <option value="">Select audio</option>
                            {(data.announcements || []).map((a: any) => (
                              <option key={a.id} value={a.id}>
                                {a.name}
                              </option>
                            ))}
                          </select>
                        </label>
                      </div>
                    ) : (
                      <>
                        <div className="days">
                          <span>Weekdays</span>
                          {days.map((d) => (
                            <button
                              type="button"
                              className={
                                announcementScheduleForm.days?.includes(d)
                                  ? "day active"
                                  : "day"
                              }
                              key={d}
                              onClick={() =>
                                setAnnouncementScheduleForm({
                                  ...announcementScheduleForm,
                                  days: announcementScheduleForm.days?.includes(
                                    d,
                                  )
                                    ? announcementScheduleForm.days.filter(
                                        (x: string) => x !== d,
                                      )
                                    : [
                                        ...(announcementScheduleForm.days ||
                                          []),
                                        d,
                                      ],
                                })
                              }
                            >
                              {d}
                            </button>
                          ))}
                        </div>
                        <div className="two-fields">
                          <label>
                            Start time
                            <input
                              type="time"
                              value={announcementScheduleForm.start}
                              onChange={(e) =>
                                setAnnouncementScheduleForm({
                                  ...announcementScheduleForm,
                                  start: e.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            First announcement
                            <select
                              value={
                                announcementScheduleForm.firstAnnouncementId
                              }
                              onChange={(e) =>
                                setAnnouncementScheduleForm({
                                  ...announcementScheduleForm,
                                  firstAnnouncementId: e.target.value,
                                })
                              }
                            >
                              <option value="">Select audio</option>
                              {(data.announcements || []).map((a: any) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                            <button
                              className="subtle"
                              type="button"
                              disabled={
                                !announcementScheduleForm.firstAnnouncementId
                              }
                              onClick={() =>
                                void playAnnouncement(
                                  announcementScheduleForm.firstAnnouncementId,
                                )
                              }
                            >
                              Test first
                            </button>
                          </label>
                        </div>
                        <div className="two-fields">
                          <label>
                            End time
                            <input
                              type="time"
                              value={announcementScheduleForm.end}
                              onChange={(e) =>
                                setAnnouncementScheduleForm({
                                  ...announcementScheduleForm,
                                  end: e.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            Second announcement
                            <select
                              value={
                                announcementScheduleForm.secondAnnouncementId
                              }
                              onChange={(e) =>
                                setAnnouncementScheduleForm({
                                  ...announcementScheduleForm,
                                  secondAnnouncementId: e.target.value,
                                })
                              }
                            >
                              <option value="">Select audio</option>
                              {(data.announcements || []).map((a: any) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                            <button
                              className="subtle"
                              type="button"
                              disabled={
                                !announcementScheduleForm.secondAnnouncementId
                              }
                              onClick={() =>
                                void playAnnouncement(
                                  announcementScheduleForm.secondAnnouncementId,
                                )
                              }
                            >
                              Test second
                            </button>
                          </label>
                        </div>
                      </>
                    )}
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        checked={announcementScheduleForm.enabled}
                        onChange={(e) =>
                          setAnnouncementScheduleForm({
                            ...announcementScheduleForm,
                            enabled: e.target.checked,
                          })
                        }
                      />
                      Enabled
                    </label>
                    <button
                      className="primary"
                      onClick={() => {
                        const issue = validateAnnouncementSchedule(
                          announcementScheduleForm,
                        );
                        if (issue) {
                          notify(issue);
                          return;
                        }
                        const conflict =
                          !announcementScheduleForm.date &&
                          (data.announcementSchedules || []).find(
                            (x: any) =>
                              !x.date &&
                              x.id !== announcementScheduleForm.id &&
                              x.enabled &&
                              announcementScheduleForm.enabled &&
                              schedulesConflict(x, announcementScheduleForm),
                          );
                        if (conflict) {
                          notify(
                            `This overlaps "${conflict.name}". Announcement schedules cannot overlap.`,
                          );
                          return;
                        }
                        const value = {
                          ...announcementScheduleForm,
                          id:
                            announcementScheduleForm.id || crypto.randomUUID(),
                          name: announcementScheduleForm.name.trim(),
                        };
                        void persist({
                          ...data,
                          announcementSchedules: saveAnnouncementSchedule(
                            data.announcementSchedules || [],
                            value,
                          ),
                        });
                        setAnnouncementScheduleForm({
                          id: "",
                          name: "",
                          days: [],
                          start: "09:00",
                          end: "17:00",
                          firstAnnouncementId: "",
                          secondAnnouncementId: "",
                          enabled: true,
                        });
                      }}
                    >
                      {announcementScheduleForm.id
                        ? "Save changes"
                        : "Create schedule"}
                    </button>
                    {announcementScheduleForm.id && (
                      <button
                        className="subtle"
                        onClick={() =>
                          setAnnouncementScheduleForm({
                            id: "",
                            name: "",
                            days: [],
                            start: "09:00",
                            end: "17:00",
                            firstAnnouncementId: "",
                            secondAnnouncementId: "",
                            enabled: true,
                          })
                        }
                      >
                        Cancel edit
                      </button>
                    )}
                  </div>
                  <div className="panel">
                    <h3>Announcement schedules</h3>
                    {(data.announcementSchedules || []).map((s: any) => {
                      const first = (data.announcements || []).find(
                        (a: any) =>
                          a.id === (s.announcementId || s.firstAnnouncementId),
                      );
                      const second = (data.announcements || []).find(
                        (a: any) => a.id === s.secondAnnouncementId,
                      );
                      return (
                        <div className="schedule-row" key={s.id}>
                          <div className="schedule-name">
                            <b>{s.name}</b>
                            <span>
                              {s.date
                                ? `${s.date} | ${s.time} | ${s.repeat === "yearly" ? "Yearly" : "One time"} | ${first?.name || "Missing audio"}`
                                : `${(s.days || []).join(", ")} | ${s.start} - ${first?.name || "Missing first audio"} | ${s.end} - ${second?.name || "Missing second audio"}`}
                            </span>
                          </div>
                          <label className="toggle-label">
                            <input
                              type="checkbox"
                              checked={s.enabled}
                              onChange={(e) =>
                                void persist({
                                  ...data,
                                  announcementSchedules:
                                    setAnnouncementScheduleEnabled(
                                      data.announcementSchedules,
                                      s.id,
                                      e.target.checked,
                                    ),
                                })
                              }
                            />
                            {s.enabled ? "Enabled" : "Disabled"}
                          </label>
                          <button
                            className="icon-btn"
                            aria-label="Edit schedule"
                            onClick={() =>
                              setAnnouncementScheduleForm({
                                ...s,
                                days: [...(s.days || [])],
                              })
                            }
                          >
                            <Pencil />
                          </button>
                          <button
                            className="icon-btn"
                            aria-label="Delete schedule"
                            onClick={() =>
                              void persist({
                                ...data,
                                announcementSchedules:
                                  removeAnnouncementSchedule(
                                    data.announcementSchedules,
                                    s.id,
                                  ),
                              })
                            }
                          >
                            <Trash2 />
                          </button>
                        </div>
                      );
                    })}
                    {!(data.announcementSchedules || []).length && (
                      <Empty
                        title="No announcement schedules"
                        text="Create a weekly or specific-date announcement schedule."
                      />
                    )}
                  </div>
                  <div className="panel">
                    <h3>Upcoming scheduled announcements</h3>
                    {upcomingAnnouncementOccurrences(
                      data.announcementSchedules || [],
                      data.announcements || [],
                      localNow,
                    ).map((event: any) => (
                      <div
                        className="schedule-row"
                        key={`${event.scheduleId}:${event.boundary}:${event.date}`}
                      >
                        <div className="schedule-name">
                          <b>
                            {event.scheduleName} ·{" "}
                            {event.custom
                              ? "Announcement"
                              : event.boundary === "start"
                                ? "First announcement"
                                : "Second announcement"}
                          </b>
                          <span>
                            {event.date} · {event.time} ·{" "}
                            {event.audioName || "Audio unavailable"}
                          </span>
                        </div>
                      </div>
                    ))}
                    {!upcomingAnnouncementOccurrences(
                      data.announcementSchedules || [],
                      data.announcements || [],
                      localNow,
                    ).length && (
                      <Empty
                        title="No upcoming announcements"
                        text="Enabled announcement events will appear here."
                      />
                    )}
                  </div>
                </>
              )}
              {audioManagerSection === "advertisements" && (
                <>
                  <PageHeading
                    title="Advertisements"
                    sub="Manage and preview local advertisement audio."
                    action={
                      <button
                        className="primary"
                        disabled={advertisementBusy}
                        onClick={async () => {
                          setAdvertisementBusy(true);
                          try {
                            const added =
                              await window.twc.advertisementsImport();
                            if (added.length)
                              await persist({
                                ...data,
                                advertisements: [
                                  ...(data.advertisements || []),
                                  ...added,
                                ],
                              });
                          } catch (e) {
                            notify(String(e));
                          } finally {
                            setAdvertisementBusy(false);
                          }
                        }}
                      >
                        <Plus size={18} />
                        Import audio
                      </button>
                    }
                  />
                  <div className="panel">
                    <h3>Advertisement library</h3>
                    <p className="audio-policy-note">
                      Advertisement previews are local only. Automatic playback
                      alongside Spotify is disabled pending policy approval.
                    </p>
                    {(data.advertisements || []).length ? (
                      <div className="schedule-list">
                        {data.advertisements.map((item: any) => (
                          <div className="schedule-row" key={item.id}>
                            <div className="schedule-name">
                              <b>{item.name}</b>
                              <span>
                                {item.description || "No description"} ·{" "}
                                {advertisementDurations[item.id]
                                  ? `${Math.floor(advertisementDurations[item.id] / 60)}:${String(Math.floor(advertisementDurations[item.id] % 60)).padStart(2, "0")}`
                                  : "Duration unavailable"}
                              </span>
                              <label>
                                Volume{" "}
                                {advertisementVolumeDrafts[item.id] ??
                                  item.volume ??
                                  100}
                                %
                                <input
                                  aria-label={`${item.name} advertisement volume`}
                                  type="range"
                                  min="0"
                                  max="100"
                                  value={
                                    advertisementVolumeDrafts[item.id] ??
                                    item.volume ??
                                    100
                                  }
                                  onChange={(e) => {
                                    const volume = Number(e.target.value);
                                    setAdvertisementVolumeDrafts((current) => ({
                                      ...current,
                                      [item.id]: volume,
                                    }));
                                    if (
                                      activeTestAdvertisementId === item.id &&
                                      advertisementAudioRef.current
                                    )
                                      advertisementAudioRef.current.volume =
                                        volume / 100;
                                  }}
                                  onPointerUp={(e) =>
                                    void updateAdvertisement(item.id, {
                                      volume: Number(e.currentTarget.value),
                                    })
                                  }
                                  onKeyUp={(e) =>
                                    void updateAdvertisement(item.id, {
                                      volume: Number(e.currentTarget.value),
                                    })
                                  }
                                />
                              </label>
                            </div>
                            <label className="toggle-label">
                              <input
                                type="checkbox"
                                checked={item.enabled}
                                onChange={(e) =>
                                  void updateAdvertisement(item.id, {
                                    enabled: e.target.checked,
                                  })
                                }
                              />
                              Enabled
                            </label>
                            <button
                              className="icon-btn"
                              aria-label="Edit advertisement"
                              onClick={() => {
                                const name = window.prompt(
                                  "Advertisement name",
                                  item.name,
                                );
                                if (!name?.trim()) return;
                                const description = window.prompt(
                                  "Advertisement description",
                                  item.description || "",
                                );
                                if (description !== null)
                                  void updateAdvertisement(item.id, {
                                    name: name.trim(),
                                    description: description.trim(),
                                  });
                              }}
                            >
                              <Pencil size={17} />
                            </button>
                            {activeTestAdvertisementId === item.id ? (
                              <button
                                className="subtle"
                                onClick={stopTestAdvertisement}
                              >
                                Stop Preview
                              </button>
                            ) : (
                              <button
                                className="subtle"
                                onClick={() => void testAdvertisement(item.id)}
                              >
                                <Play size={16} />
                                Test Advertisement
                              </button>
                            )}
                            <button
                              className="icon-btn"
                              aria-label="Delete advertisement"
                              onClick={async () => {
                                if (!confirm(`Delete ${item.name}?`)) return;
                                try {
                                  await window.twc.advertisementsDeleteFile(
                                    item.id,
                                  );
                                  await persist({
                                    ...data,
                                    advertisements: data.advertisements.filter(
                                      (x: any) => x.id !== item.id,
                                    ),
                                  });
                                } catch (e) {
                                  notify(String(e));
                                }
                              }}
                            >
                              <Trash2 />
                            </button>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <Empty
                        title="No advertisements imported"
                        text="Import MP3 or WAV audio to build your advertisement library."
                      />
                    )}
                  </div>
                  <div className="panel form-panel">
                    <h3>
                      {advertisementScheduleForm.id
                        ? "Edit advertisement schedule"
                        : "Create advertisement schedule"}
                    </h3>
                    <p className="audio-policy-note">
                      Schedules are saved as configuration only. Automatic
                      playback alongside Spotify remains disabled pending policy
                      approval.
                    </p>
                    <label>
                      Schedule name
                      <input
                        maxLength={80}
                        value={advertisementScheduleForm.name}
                        onChange={(e) =>
                          setAdvertisementScheduleForm({
                            ...advertisementScheduleForm,
                            name: e.target.value,
                          })
                        }
                        placeholder="Weekday promotions"
                      />
                    </label>
                    <label>
                      Schedule type
                      <select
                        value={advertisementScheduleForm.type}
                        onChange={(e) =>
                          setAdvertisementScheduleForm({
                            ...advertisementScheduleForm,
                            type: e.target.value,
                            times:
                              e.target.value === "weekly"
                                ? advertisementScheduleForm.times
                                : [],
                          })
                        }
                      >
                        <option value="weekly">Weekly - specific times</option>
                        <option value="random">
                          Random during operating hours
                        </option>
                        <option value="repeat">Repeat at interval</option>
                      </select>
                    </label>
                    <div className="days">
                      <span>Weekdays</span>
                      {days.map((day) => (
                        <button
                          type="button"
                          className={
                            advertisementScheduleForm.days.includes(day)
                              ? "day active"
                              : "day"
                          }
                          key={day}
                          onClick={() =>
                            setAdvertisementScheduleForm({
                              ...advertisementScheduleForm,
                              days: advertisementScheduleForm.days.includes(day)
                                ? advertisementScheduleForm.days.filter(
                                    (value: string) => value !== day,
                                  )
                                : [...advertisementScheduleForm.days, day],
                            })
                          }
                        >
                          {day}
                        </button>
                      ))}
                    </div>
                    <div className="two-fields">
                      <label>
                        Start time
                        <input
                          type="time"
                          value={advertisementScheduleForm.start}
                          onChange={(e) =>
                            setAdvertisementScheduleForm({
                              ...advertisementScheduleForm,
                              start: e.target.value,
                            })
                          }
                        />
                      </label>
                      <label>
                        End time
                        <input
                          type="time"
                          value={advertisementScheduleForm.end}
                          onChange={(e) =>
                            setAdvertisementScheduleForm({
                              ...advertisementScheduleForm,
                              end: e.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                    {advertisementScheduleForm.type === "weekly" && (
                      <div className="form-field">
                        <label>Playback times</label>
                        <div className="ad-time-entry">
                          <input
                            aria-label="New playback time"
                            type="time"
                            value={advertisementScheduleForm.timeDraft}
                            onChange={(e) =>
                              setAdvertisementScheduleForm({
                                ...advertisementScheduleForm,
                                timeDraft: e.target.value,
                              })
                            }
                          />
                          <button
                            type="button"
                            className="subtle"
                            onClick={() => {
                              if (
                                !advertisementScheduleForm.times.includes(
                                  advertisementScheduleForm.timeDraft,
                                )
                              )
                                setAdvertisementScheduleForm({
                                  ...advertisementScheduleForm,
                                  times: [
                                    ...advertisementScheduleForm.times,
                                    advertisementScheduleForm.timeDraft,
                                  ].sort(),
                                });
                            }}
                          >
                            Add time
                          </button>
                        </div>
                        <div className="ad-time-list">
                          {advertisementScheduleForm.times.map(
                            (time: string) => (
                              <span key={time}>
                                {time}
                                <button
                                  type="button"
                                  aria-label={`Remove ${time}`}
                                  onClick={() =>
                                    setAdvertisementScheduleForm({
                                      ...advertisementScheduleForm,
                                      times:
                                        advertisementScheduleForm.times.filter(
                                          (value: string) => value !== time,
                                        ),
                                    })
                                  }
                                >
                                  ×
                                </button>
                              </span>
                            ),
                          )}
                        </div>
                      </div>
                    )}
                    {advertisementScheduleForm.type === "random" && (
                      <div className="two-fields">
                        <label>
                          Minimum interval (minutes)
                          <input
                            type="number"
                            min="1"
                            max="1440"
                            value={advertisementScheduleForm.minIntervalMinutes}
                            onChange={(e) =>
                              setAdvertisementScheduleForm({
                                ...advertisementScheduleForm,
                                minIntervalMinutes: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                        <label>
                          Maximum interval (minutes)
                          <input
                            type="number"
                            min="1"
                            max="1440"
                            value={advertisementScheduleForm.maxIntervalMinutes}
                            onChange={(e) =>
                              setAdvertisementScheduleForm({
                                ...advertisementScheduleForm,
                                maxIntervalMinutes: Number(e.target.value),
                              })
                            }
                          />
                        </label>
                      </div>
                    )}
                    {advertisementScheduleForm.type === "repeat" && (
                      <label>
                        Repeat interval (minutes)
                        <input
                          type="number"
                          min="1"
                          max="1440"
                          value={
                            advertisementScheduleForm.repeatIntervalMinutes
                          }
                          onChange={(e) =>
                            setAdvertisementScheduleForm({
                              ...advertisementScheduleForm,
                              repeatIntervalMinutes: Number(e.target.value),
                            })
                          }
                        />
                      </label>
                    )}
                    <fieldset className="ad-selection">
                      <legend>Enabled advertisements</legend>
                      {(data.advertisements || [])
                        .filter((item: any) => item.enabled)
                        .map((item: any) => (
                          <label key={item.id}>
                            <input
                              type="checkbox"
                              checked={advertisementScheduleForm.advertisementIds.includes(
                                item.id,
                              )}
                              onChange={(e) =>
                                setAdvertisementScheduleForm({
                                  ...advertisementScheduleForm,
                                  advertisementIds: e.target.checked
                                    ? [
                                        ...advertisementScheduleForm.advertisementIds,
                                        item.id,
                                      ]
                                    : advertisementScheduleForm.advertisementIds.filter(
                                        (id: string) => id !== item.id,
                                      ),
                                })
                              }
                            />
                            {item.name}
                          </label>
                        ))}
                      {!(data.advertisements || []).some(
                        (item: any) => item.enabled,
                      ) && (
                        <span>
                          Enable or import an advertisement before creating a
                          schedule.
                        </span>
                      )}
                    </fieldset>
                    {advertisementScheduleForm.advertisementIds.length > 1 && (
                      <label className="toggle-label">
                        <input
                          type="checkbox"
                          checked={advertisementScheduleForm.rotate}
                          onChange={(e) =>
                            setAdvertisementScheduleForm({
                              ...advertisementScheduleForm,
                              rotate: e.target.checked,
                            })
                          }
                        />
                        Rotate selected advertisements
                      </label>
                    )}
                    <label className="toggle-label">
                      <input
                        type="checkbox"
                        checked={advertisementScheduleForm.enabled}
                        onChange={(e) =>
                          setAdvertisementScheduleForm({
                            ...advertisementScheduleForm,
                            enabled: e.target.checked,
                          })
                        }
                      />
                      Schedule enabled
                    </label>
                    <button className="primary" onClick={saveAdSchedule}>
                      {advertisementScheduleForm.id
                        ? "Save changes"
                        : "Create schedule"}
                    </button>
                    {advertisementScheduleForm.id && (
                      <button
                        className="subtle"
                        onClick={() =>
                          setAdvertisementScheduleForm(
                            newAdvertisementScheduleForm(),
                          )
                        }
                      >
                        Cancel edit
                      </button>
                    )}
                  </div>
                  <div className="panel">
                    <h3>Advertisement schedules</h3>
                    {(data.advertisementSchedules || []).map(
                      (schedule: any) => {
                        const names = (schedule.advertisementIds || []).map(
                          (id: string) =>
                            data.advertisements.find(
                              (item: any) => item.id === id,
                            )?.name || "Unavailable advertisement",
                        );
                        const description =
                          schedule.type === "weekly"
                            ? `${(schedule.days || []).join(", ")} · ${(schedule.times || []).join(", ")} · ${schedule.start}-${schedule.end}`
                            : schedule.type === "random"
                              ? `${(schedule.days || []).join(", ")} · ${schedule.start}-${schedule.end} · Random every ${schedule.minIntervalMinutes}-${schedule.maxIntervalMinutes} min`
                              : `${(schedule.days || []).join(", ")} · ${schedule.start}-${schedule.end} · Every ${schedule.repeatIntervalMinutes} min`;
                        return (
                          <div className="schedule-row" key={schedule.id}>
                            <div className="schedule-name">
                              <b>{schedule.name}</b>
                              <span>
                                {schedule.type} · {description} ·{" "}
                                {names.join(schedule.rotate ? " → " : ", ")}
                              </span>
                              <span className="audio-schedule-blocked">
                                Automatic playback disabled pending policy
                                approval
                              </span>
                            </div>
                            <label className="toggle-label">
                              <input
                                type="checkbox"
                                checked={schedule.enabled}
                                onChange={(e) =>
                                  void persist({
                                    ...data,
                                    advertisementSchedules:
                                      setAdvertisementScheduleEnabled(
                                        data.advertisementSchedules || [],
                                        schedule.id,
                                        e.target.checked,
                                      ),
                                  })
                                }
                              />
                              {schedule.enabled ? "Enabled" : "Disabled"}
                            </label>
                            <button
                              className="icon-btn"
                              aria-label="Edit advertisement schedule"
                              onClick={() => {
                                const enabledIds = new Set(
                                  (data.advertisements || [])
                                    .filter((item: any) => item.enabled)
                                    .map((item: any) => item.id),
                                );
                                setAdvertisementScheduleForm({
                                  ...newAdvertisementScheduleForm(),
                                  ...schedule,
                                  days: [...schedule.days],
                                  times: [...schedule.times],
                                  advertisementIds:
                                    schedule.advertisementIds.filter(
                                      (id: string) => enabledIds.has(id),
                                    ),
                                });
                              }}
                            >
                              <Pencil />
                            </button>
                            <button
                              className="icon-btn"
                              aria-label="Delete advertisement schedule"
                              onClick={() => {
                                if (confirm(`Delete ${schedule.name}?`))
                                  void persist({
                                    ...data,
                                    advertisementSchedules:
                                      removeAdvertisementSchedule(
                                        data.advertisementSchedules || [],
                                        schedule.id,
                                      ),
                                  });
                              }}
                            >
                              <Trash2 />
                            </button>
                          </div>
                        );
                      },
                    )}
                    {!(data.advertisementSchedules || []).length && (
                      <Empty
                        title="No advertisement schedules"
                        text="Create a weekly, random, or repeat schedule."
                      />
                    )}
                  </div>
                </>
              )}
            </>
          )}
          {page === "Settings" && (
            <>
              <PageHeading
                title="Settings"
                sub="Application preferences and connected services."
              />
              <div className="panel form-panel updater-panel">
                <h3>Application Updates</h3>
                <div className="setting-readonly"><b>Installed version</b><span>{updateStatus.currentVersion || branding.version || "…"}</span></div>
                <p className={`updater-message updater-${updateStatus.status}`}>{updateStatus.message}</p>
                {updateStatus.status === "downloading" && <div className="update-progress" role="progressbar" aria-label="Update download progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={updateStatus.percent || 0}><span style={{ width: `${updateStatus.percent || 0}%` }} /></div>}
                <div className="form-inline">
                  <button className="primary" disabled={["unsupported", "checking", "available", "downloading", "downloaded"].includes(updateStatus.status)} onClick={() => { void window.twc.updaterCheck().then(setUpdateStatus).catch((error) => notify(String(error).replace(/^Error: /, ""))); }}>{updateStatus.status === "checking" ? "Checking…" : "Check for Updates"}</button>
                  {updateStatus.status === "downloaded" && <button className="primary" onClick={() => void window.twc.updaterInstall().catch((error) => notify(String(error).replace(/^Error: /, "")))}>Restart and Install Update{updateStatus.version ? ` ${updateStatus.version}` : ""}</button>}
                </div>
              </div>
              <div className="panel form-panel branding-panel">
                <h3>Application Branding</h3>
                <p>Personalize the name and images shown in this installation.</p>
                <label>Pharmacy Name<input maxLength={100} value={branding.pharmacyName} onChange={(e) => setBranding((current: any) => ({ ...current, pharmacyName: e.target.value }))} /></label>
                <div className="branding-upload-grid">
                  <div><b>Pharmacy Logo</b><div className="branding-preview">{branding.pharmacyLogoPreview ? <img src={branding.pharmacyLogoPreview} alt="Pharmacy logo preview" /> : <span>Default TWC logo</span>}</div><button className="subtle" onClick={() => void uploadBrandAsset("logo")}>Choose Logo</button></div>
                  <div><b>Application Icon</b><div className="branding-preview icon-preview">{branding.pharmacyIconPreview ? <img src={branding.pharmacyIconSizes?.[128] || branding.pharmacyIconPreview} alt="Application icon preview" /> : <span>Default TWC icon</span>}</div><button className="subtle" onClick={() => void uploadBrandAsset("icon")}>Choose Icon</button></div>
                </div>
                <small>PNG, JPG, JPEG, or WebP. Maximum file size: 5 MB. The Windows executable icon is set during packaging.</small>
                <div className="form-inline"><button className="primary" onClick={() => void window.twc.brandingSave(branding).then(setBranding).then(() => notify("Application branding saved.")).catch((e) => notify(String(e).replace(/^Error: /, "")))}>Save Changes</button><button className="subtle" onClick={() => void window.twc.brandingReset().then(setBranding).then(() => notify("Default TWC branding restored.")).catch((e) => notify(String(e)))}>Reset to Default</button></div>
              </div>
              <div className="panel form-panel">
                <h3>Spotify</h3>
                <p>
                  Connect using Spotify's authorization code with PKCE. Tokens
                  stay in Electron's main process and are encrypted with the
                  operating system credential store.
                </p>
                <label>
                  Spotify Client ID
                  <input
                    value={data.settings.spotifyClientId || ""}
                    onChange={(e) =>
                      updateSetting("spotifyClientId", e.target.value)
                    }
                    placeholder="Enter your Spotify app Client ID"
                  />
                </label>
                <div className="form-inline">
                  <span
                    className={
                      spotify.connected ? "connected-dot" : "disconnected-dot"
                    }
                  ></span>
                  <span>
                    {spotify.connected
                      ? `Connected as ${spotify.name}`
                      : spotify.message}
                  </span>
                  <button className="primary" disabled={busy} onClick={connect}>
                    {busy
                      ? "Waiting for authorization..."
                      : spotify.connected
                        ? "Reconnect Spotify"
                        : "Connect Spotify"}
                  </button>
                  {spotify.connected && (
                    <button className="subtle" onClick={disconnect}>
                      Disconnect Spotify
                    </button>
                  )}
                </div>
                <small>
                  Create a Spotify app and allow the local callback URL shown
                  during authorization. Required scopes: playlist read, profile,
                  and playback state/control.
                </small>
                <small className="policy-note">
                  Spotify accounts are for personal, non-commercial use. Spotify
                  says its service must not be played publicly from a business.{" "}
                  <a
                    href="https://support.spotify.com/us/article/spotify-public-commercial-use/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Spotify's public-use policy
                  </a>
                </small>
              </div>
              <div className="panel form-panel google-panel">
                <h3>Google Business Profile</h3>
                <p>
                  Official Business Information API integration. OAuth uses the
                  system browser and loopback callback; access tokens remain
                  encrypted in Electron secure storage.
                </p>
                <section className="google-settings-section">
                  <h4>Account</h4>
                  <label>
                    Google OAuth Desktop Client ID
                    <input
                      value={data.settings.googleClientId || ""}
                      onChange={(e) =>
                        updateSetting("googleClientId", e.target.value)
                      }
                      placeholder="Enter your Google OAuth client ID"
                    />
                  </label>
                  <div className="google-action-row">
                    <span
                      className={
                        googleConnected ? "connected-dot" : "disconnected-dot"
                      }
                    ></span>
                    <span className="google-status">
                      {googleDemo
                        ? "Demo mode  |  mock data"
                        : googleConnected
                          ? "Google account connected"
                          : "Google account not connected"}
                    </span>
                    <button
                      className="primary"
                      disabled={googleBusy}
                      onClick={() => void googleConnect()}
                    >
                      {googleBusy ? "Connecting..." : "Connect Google Account"}
                    </button>
                    {googleConnected && (
                      <button
                        className="subtle"
                        disabled={googleBusy}
                        onClick={() =>
                          void (window.twc as any)
                            .googleDisconnect()
                            .then(() => {
                              setGoogleConnected(false);
                              setGoogleLocations([]);
                            })
                        }
                      >
                        Disconnect
                      </button>
                    )}
                    <button
                      className="subtle"
                      disabled={googleBusy}
                      onClick={setGoogleDemo}
                    >
                      Load demo/test data
                    </button>
                  </div>
                  <section className="csv-import-help">
                    <div>
                      <h4>Import business hours from CSV</h4>
                      <p>
                        Choose the matching CSV type. Review the parsed hours
                        and grouped schedules before applying changes.
                      </p>
                      <div className="csv-template-actions">
                        <button
                          className="subtle"
                          onClick={() =>
                            downloadBusinessHoursCsvTemplate("weekly")
                          }
                        >
                          Download Weekly Hours Template (.csv)
                        </button>
                        <button
                          className="subtle"
                          onClick={() =>
                            downloadBusinessHoursCsvTemplate("holidays")
                          }
                        >
                          Download Holiday Exceptions Template (.csv)
                        </button>
                      </div>
                      <div className="csv-format-grid">
                        <div>
                          <b>Weekly hours columns</b>
                          <code>day, open_time, close_time, status</code>
                          <small>Example: Monday, 08:00, 18:00, open</small>
                        </div>
                        <div>
                          <b>Holiday exception columns</b>
                          <code>date, name, open_time, close_time, status</code>
                          <small>
                            Example: 2026-12-25, Christmas Day, (empty),
                            (empty), closed
                          </small>
                        </div>
                      </div>
                      <ul>
                        <li>
                          Weekly hours use full weekday names; holiday
                          exceptions use YYYY-MM-DD dates.
                        </li>
                        <li>
                          Times use 24-hour HH:mm format. Status must be open or
                          closed.
                        </li>
                        <li>
                          Closed rows can have empty opening and closing times.
                        </li>
                        <li>
                          Matching weekly time ranges are grouped into one
                          schedule with multiple selected days.
                        </li>
                        <li>
                          Holiday exceptions override regular hours only on
                          their specified dates.
                        </li>
                      </ul>
                    </div>
                    <div className="csv-upload-actions">
                      <input
                        ref={weeklyCsvInput}
                        type="file"
                        accept=".csv,text/csv"
                        hidden
                        onChange={(event) =>
                          void importBusinessHoursCsv(event, "weekly")
                        }
                      />
                      <button
                        className="primary"
                        disabled={googleBusy || googleImporting}
                        onClick={() => weeklyCsvInput.current?.click()}
                      >
                        <FileUp size={16} />
                        Upload Weekly Hours CSV
                      </button>
                      <input
                        ref={holidayCsvInput}
                        type="file"
                        accept=".csv,text/csv"
                        hidden
                        onChange={(event) =>
                          void importBusinessHoursCsv(event, "holidays")
                        }
                      />
                      <button
                        className="primary"
                        disabled={googleBusy || googleImporting}
                        onClick={() => holidayCsvInput.current?.click()}
                      >
                        <FileUp size={16} />
                        Upload Holiday Exceptions CSV
                      </button>
                    </div>
                  </section>
                  <small>
                    Google documents the Desktop token exchange secret as
                    optional. If Google reports that a client secret is missing,
                    import the downloaded Desktop OAuth JSON here; Electron
                    encrypts its secret in system storage.
                  </small>
                  <button
                    className="subtle"
                    disabled={googleBusy || !data.settings.googleClientId}
                    onClick={() => void googleImportDesktopClient()}
                  >
                    Import optional Desktop OAuth client JSON
                  </button>
                </section>
                {googleLocations.length > 0 && (
                  <section className="google-settings-section">
                    <h4>Business location and hours</h4>
                    <label>
                      Business location
                      <select
                        value={
                          data.settings.googleLocation ||
                          (googleDemo ? "demo" : "")
                        }
                        onChange={(e) => {
                          const location = googleLocations.find(
                            (x) => x.name === e.target.value,
                          );
                          persist({
                            ...data,
                            settings: {
                              ...data.settings,
                              googleLocation: e.target.value,
                              googleLocationTitle: location?.title || "",
                            },
                          });
                          setGooglePreview(null);
                          setGoogleHoursSource(null);
                          setGoogleHours(null);
                          setGoogleDemoMode(false);
                        }}
                      >
                        <option value="">Select a location</option>
                        {googleLocations.map((x) => (
                          <option key={x.name} value={x.name}>
                            {x.title}
                            {googleDemo ? " (demo)" : ""}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="google-action-row">
                      <button
                        className="subtle"
                        disabled={googleBusy || !data.settings.googleLocation}
                        onClick={() =>
                          googleDemo
                            ? setGoogleHours(
                                parseBusinessHours(demoBusinessHours),
                              )
                            : void googleRefresh()
                        }
                      >
                        <RefreshCw size={16} />
                        Refresh Schedule
                      </button>
                      <label>
                        Auto sync
                        <select
                          value={data.settings.googleSyncMinutes || 0}
                          onChange={(e) =>
                            updateSetting(
                              "googleSyncMinutes",
                              Number(e.target.value),
                            )
                          }
                        >
                          <option value="0">Manual only</option>
                          <option value="60">Every hour</option>
                          <option value="360">Every 6 hours</option>
                          <option value="1440">Daily</option>
                        </select>
                      </label>
                    </div>
                  </section>
                )}
                {data.settings.googleLastSync && (
                  <small>
                    Last successful live sync:{" "}
                    {new Date(data.settings.googleLastSync).toLocaleString()}
                  </small>
                )}
                {googleError && (
                  <p className="spotify-open-error">{googleError}</p>
                )}
                {googleHours && (
                  <section className="google-settings-section">
                    <h4>
                      {googleHoursSource?.kind === "csv"
                        ? googleHoursSource.title
                        : googleDemo
                          ? "Demo weekly hours  |  test data"
                          : "Regular business hours and holiday exceptions"}
                    </h4>
                    <div className="schedule-list">
                      {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map(
                        (day) => {
                          const periods = googleHours.regular.filter(
                            (x: any) => x.day === day,
                          );
                          return (
                            <div className="schedule-row" key={day}>
                              <b>{day}</b>
                              <span>
                                {periods.length
                                  ? periods
                                      .map(
                                        (x: any) =>
                                          `${x.start}-${x.end}${x.overnight ? " (overnight)" : ""}`,
                                      )
                                      .join(", ")
                                  : googleHours.closedDays.includes(day)
                                    ? "Closed (explicitly listed)"
                                    : "No hours provided"}
                              </span>
                            </div>
                          );
                        },
                      )}
                      {googleHours.special.map((x: any) => (
                        <div className="schedule-row" key={x.date}>
                          <b>
                            {x.date}
                            {x.name ? `  |  ${x.name}` : ""}
                          </b>
                          <span>
                            {x.closed
                              ? "Closed  |  holiday exception"
                              : `${x.start}-${x.end}  |  special hours`}
                          </span>
                        </div>
                      ))}
                    </div>
                    <div className="google-import-row">
                      <small>
                        Playlist:{" "}
                        {playlists.find(
                          (p: any) => p.id === data.settings.defaultPlaylist,
                        )?.name || "Select a default playlist under Playlists"}
                      </small>
                      <button
                        className="primary"
                        disabled={
                          !data.settings.defaultPlaylist ||
                          !(
                            googleHoursSource ||
                            data.settings.googleLocation ||
                            googleDemo
                          ) ||
                          googleBusy ||
                          googleImporting
                        }
                        onClick={previewGoogleImport}
                      >
                        Preview Import
                      </button>
                    </div>
                  </section>
                )}
                {googlePreview && (
                  <div className="google-review panel">
                    <h4>Review schedule changes</h4>
                    <div className="google-summary">
                      <span>
                        <b>{googlePreview.schedules.length}</b> new or updated
                        periods
                      </span>
                      <span>
                        <b>{googlePreview.exceptions.length}</b> holiday
                        overrides
                      </span>
                      <span>
                        <b>{googlePreview.duplicates}</b> duplicates skipped
                      </span>
                      <span>
                        <b>{googlePreview.conflicts.length}</b> conflicts found
                      </span>
                    </div>
                    <div className="google-schedule-preview">
                      {googlePreview.previewSchedules.map((schedule: any) => (
                        <div className="schedule-row" key={schedule.id}>
                          <b>
                            {schedule.dates?.[0] || schedule.days.join(", ")}
                          </b>
                          <span>
                            {schedule.start}-{schedule.end}
                            {schedule.dates
                              ? "  |  holiday exception"
                              : "  |  weekly schedule"}
                            <small>
                              {schedule.isDuplicate
                                ? "Already imported  |  duplicate skipped"
                                : schedule.dates
                                  ? "Date-specific override"
                                  : `Selected days: ${schedule.days.join(", ")}`}
                            </small>
                          </span>
                        </div>
                      ))}
                    </div>
                    {googlePreview.conflicts.length > 0 && (
                      <>
                        <p>
                          Resolve each conflicting weekday or date. Keeping an
                          existing schedule excludes imported hours for the
                          affected day; other matching weekdays remain grouped.
                          Replacing removes the conflicting schedule only after
                          you apply.
                        </p>
                        <ul className="google-conflicts">
                          {googlePreview.conflicts.map((conflict: any) => (
                            <li key={conflict.id}>
                              <div>
                                <b>
                                  {conflict.location} | {conflict.day}
                                </b>
                                <span>
                                  Imported {conflict.candidate.start}-
                                  {conflict.candidate.end} overlaps "
                                  {conflict.existing.name}" (
                                  {conflict.existing.start}-
                                  {conflict.existing.end})
                                </span>
                              </div>
                              <div className="google-conflict-actions">
                                <button
                                  className={
                                    googleResolutions[conflict.id] === "keep"
                                      ? "primary"
                                      : "subtle"
                                  }
                                  disabled={googleImporting}
                                  onClick={() =>
                                    setGoogleResolutions({
                                      ...googleResolutions,
                                      [conflict.id]: "keep",
                                    })
                                  }
                                >
                                  Keep existing
                                </button>
                                <button
                                  className={
                                    googleResolutions[conflict.id] === "replace"
                                      ? "primary"
                                      : "subtle"
                                  }
                                  disabled={googleImporting}
                                  onClick={() =>
                                    setGoogleResolutions({
                                      ...googleResolutions,
                                      [conflict.id]: "replace",
                                    })
                                  }
                                >
                                  Replace existing
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </>
                    )}
                    {googlePreview.special.map((x: any) => (
                      <div className="schedule-row" key={x.date}>
                        <b>
                          {x.date}
                          {x.schedule?.name ? `  |  ${x.schedule.name}` : ""}
                        </b>
                        <span>
                          {x.closed
                            ? "Close imported music for this date"
                            : `Use ${x.schedule.start}-${x.schedule.end} on this date`}
                          {x.duplicate ? "  |  already imported" : ""}
                        </span>
                      </div>
                    ))}
                    <div className="google-review-actions">
                      <button
                        className="primary"
                        disabled={
                          googleImporting ||
                          googlePreview.conflicts.some(
                            (x: any) => !googleResolutions[x.id],
                          )
                        }
                        onClick={() => void applyGoogleImport()}
                      >
                        {googleImporting ? "Applying..." : "Apply changes"}
                      </button>
                      <button
                        className="subtle"
                        disabled={googleImporting}
                        onClick={() => {
                          setGooglePreview(null);
                          setGoogleResolutions({});
                        }}
                      >
                        Cancel import
                      </button>
                    </div>
                  </div>
                )}
              </div>{" "}
              <div className="panel form-panel">
                <h3>Scheduler</h3>
                <div className="setting-readonly">
                  <b>Computer time zone</b>
                  <span>
                    {Intl.DateTimeFormat().resolvedOptions().timeZone ||
                      "Windows local time"}
                  </span>
                </div>
                <label className="checkline">
                  <input
                    type="checkbox"
                    checked={!!data.settings.schedulerEnabled}
                    onChange={(e) =>
                      updateSetting("schedulerEnabled", e.target.checked)
                    }
                  />{" "}
                  Enable scheduler
                </label>
                <small>
                  Schedule times always follow the Windows computer's current
                  local time and time-zone rules.
                </small>
                <button
                  className="subtle"
                  onClick={() => {
                    if (
                      !confirm(
                        "Restore scheduler and Spotify preferences to defaults and disconnect Spotify?",
                      )
                    )
                      return;
                    void window.twc
                      .spotifyDisconnect()
                      .then(setSpotify)
                      .catch(() => undefined);
                    const next = {
                      ...data,
                      settings: {
                        ...data.settings,
                        schedulerEnabled: true,
                        defaultPlaylist: "",
                        spotifyClientId: "",
                      },
                    };
                    void persist(next);
                  }}
                >
                  Restore settings defaults
                </button>
              </div>
              <div className="panel form-panel">
                <h3>Audio</h3>
                <p>
                  A short test tone is sent through the Windows default audio
                  output. The app can confirm playback was requested, but you
                  must confirm that it is audible.
                </p>
                <button className="subtle" onClick={audioTest}>
                  <Volume2 size={18} />
                  Test audio output
                </button>
              </div>
            </>
          )}
          {page === "Logs" && (
            <>
              <PageHeading
                title="Logs"
                sub="Recent application activity and integration errors."
                action={
                  <button
                    className="subtle"
                    onClick={() => {
                      if (confirm("Clear all logs?"))
                        void window.twc
                          .logsClear()
                          .then(() =>
                            setData((current: any) => ({
                              ...current,
                              logs: [],
                            })),
                          )
                          .catch((e) => notify(String(e)));
                    }}
                  >
                    <Trash2 size={17} />
                    Clear logs
                  </button>
                }
              />
              <div className="panel">
                {data.logs?.length ? (
                  <div className="log-list">
                    {data.logs.map((l: any, i: number) => (
                      <div className="log-row" key={i}>
                        <time>{new Date(l.time).toLocaleString()}</time>
                        <b className={`level ${l.level}`}>{l.level}</b>
                        <span>{l.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <Empty
                    title="No logs yet"
                    text="Application and integration events will appear here."
                  />
                )}
              </div>
            </>
          )}
          {page === "About" && (
            <>
              <PageHeading title="About" sub={`${branding.pharmacyName} Music Scheduler`} />
              <div className="panel about">
                <span className="app-mark">
                  <img src={branding.pharmacyLogoPreview || branding.pharmacyIconSizes?.[128] || branding.pharmacyIconPreview || "./icons/app-icon.ico"} alt={`${branding.pharmacyName} brand`} />
                </span>
                <h2>{branding.pharmacyName}</h2>
                <p>Music Scheduler | Version {branding.version || "…"}</p>
                <p>
                  A local desktop tool for configuring music schedules and quiet
                  hours.
                </p>
                <div className="about-note">
                  Schedules run while the application is open. Missed music
                  starts are skipped after shutdown or sleep; active quiet
                  periods are re-applied on startup or wake.
                </div>
                <a
                  href="https://developer.spotify.com/documentation/web-api"
                  target="_blank"
                  rel="noreferrer"
                >
                  Spotify Web API documentation <ExternalLink size={14} />
                </a>
              </div>
            </>
          )}
          <footer className="footer">
            <div className="scheduler-state">
              <Circle
                size={15}
                fill={data.settings.schedulerEnabled ? "#14b84f" : "#9aa7bb"}
                color={data.settings.schedulerEnabled ? "#14b84f" : "#9aa7bb"}
              />
              <b>
                {data.settings.schedulerEnabled
                  ? "Scheduler enabled"
                  : "Scheduler paused"}
              </b>
            </div>
            <span className="divider" />
            <span>{branding.pharmacyName} Music Scheduler v{branding.version || "…"}</span>
            <span className="footer-right">
              <img src="./hm_logo.png" alt="HM Logo" />
            </span>
          </footer>
        </div>
      </main>
      {toast && (
        <div className="toast">
          <Info size={18} />
          {toast}
          <button onClick={() => setToast("")}>
            <X size={17} />
          </button>
        </div>
      )}
      {modal !== false && (
        <ScheduleDialog
          initial={modal}
          playlists={playlists}
          schedules={data.schedules}
          onCancel={() => setModal(false)}
          onSave={saveSchedule}
          notify={notify}
        />
      )}
      {exceptionModal && (
        <ExceptionDialog
          playlists={playlists}
          existing={data.exceptions || []}
          onCancel={() => setExceptionModal(false)}
          onSave={(value: any) => {
            persist({
              ...data,
              exceptions: [...(data.exceptions || []), value],
            });
            setExceptionModal(false);
          }}
          notify={notify}
        />
      )}
    </div>
  );
}
function ExceptionDialog({
  playlists,
  existing,
  onCancel,
  onSave,
  notify,
}: any) {
  const [date, setDate] = useState("");
  const [type, setType] = useState<"skip" | "replace">("skip");
  const [playlistId, setPlaylistId] = useState("");
  const [label, setLabel] = useState("");
  function submit(e: any) {
    e.preventDefault();
    const parsed = new Date(`${date}T00:00:00`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      Number.isNaN(parsed.getTime()) ||
      `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, "0")}-${String(parsed.getDate()).padStart(2, "0")}` !==
        date
    ) {
      notify("Choose a valid exception date.");
      return;
    }
    if (existing.some((item: any) => item.date === date)) {
      notify("An exception already exists for this date.");
      return;
    }
    const playlist = playlists.find((item: any) => item.id === playlistId);
    if (type === "replace" && !playlist) {
      notify("Select an available Spotify playlist for the replacement.");
      return;
    }
    onSave({
      date,
      type,
      ...(type === "replace"
        ? { playlistId, playlistName: playlist.name }
        : {}),
      ...(label.trim() ? { label: label.trim() } : {}),
    });
  }
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-head">
          <div>
            <h2>Date exception</h2>
            <span>Change scheduled playback for one local calendar date.</span>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel}>
            <X />
          </button>
        </div>
        <label>
          Date
          <input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </label>
        <label>
          Action
          <select
            value={type}
            onChange={(e) => setType(e.target.value as "skip" | "replace")}
          >
            <option value="skip">Skip scheduled playback</option>
            <option value="replace">Use a replacement playlist</option>
          </select>
        </label>
        {type === "replace" && (
          <label>
            Replacement playlist
            <select
              value={playlistId}
              onChange={(e) => setPlaylistId(e.target.value)}
              required
            >
              <option value="">Select a Spotify playlist</option>
              {playlists.map((item: any) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Note (optional)
          <input
            maxLength={200}
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <div className="dialog-actions">
          <button type="button" className="outline" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary">
            <Check size={17} />
            Save exception
          </button>
        </div>
      </form>
    </div>
  );
}
function InfoCard({ icon: Icon, label, title, detail, onClick }: any) {
  return (
    <button className="info-card" onClick={onClick}>
      <span className="square-icon">
        <Icon size={30} />
      </span>
      <div>
        <label>{label}</label>
        <b>{title}</b>
        <span>{detail}</span>
      </div>
    </button>
  );
}
function PageHeading({ title, sub, action }: any) {
  return (
    <div className="page-heading">
      <div>
        <h1>{title}</h1>
        <p>{sub}</p>
      </div>
      {action}
    </div>
  );
}
function Empty({ title, text }: any) {
  return (
    <div className="empty">
      <span className="square-icon">
        <ListMusic />
      </span>
      <b>{title}</b>
      <span>{text}</span>
    </div>
  );
}
function BrandAsset({ variant }: { variant: "logo" | "mark" }) {
  const [candidate, setCandidate] = useState(0);
  const files =
    variant === "logo"
      ? ["./branding/twc-stafford-logo.svg", "./branding/twc-stafford-logo.png"]
      : [
          "./branding/twc-stafford-mark.svg",
          "./branding/twc-stafford-mark.png",
        ];
  if (candidate >= files.length)
    return variant === "logo" ? (
      <div className="brand-fallback-text">
        <b>TWC Stafford</b>
        <span>Music Scheduler</span>
      </div>
    ) : (
      <span className="title-icon icon-wrapper">
        <Music2 />
      </span>
    );
  return (
    <img
      className={variant === "logo" ? "brand-image" : "title-brand-image"}
      src={files[candidate]}
      alt={variant === "logo" ? "TWC Stafford" : "TWC Stafford mark"}
      onError={() => setCandidate((i) => i + 1)}
    />
  );
}
function ScheduleDialog({
  initial,
  playlists,
  schedules,
  onCancel,
  onSave,
  notify,
}: any) {
  const [form, setForm] = useState<Schedule>(
    initial || {
      id: crypto.randomUUID(),
      name: "Music schedule",
      days: ["Mon", "Tue", "Wed", "Thu", "Fri"],
      start: "09:00",
      end: "17:00",
      playlistId: "",
      playlistName: "",
      enabled: true,
      quiet: false,
    },
  );
  const set = (k: string, v: any) => setForm({ ...form, [k]: v });
  const specificDate = !!form.date;
  function submit(e: any) {
    e.preventDefault();
    if (!form.name.trim()) {
      notify("Enter a schedule name.");
      return;
    }
    const invalid = validateSchedule(form);
    if (invalid) {
      notify(invalid);
      return;
    }
    if (form.enabled && !form.quiet && !form.playlistId) {
      notify("Select a Spotify playlist for this enabled music schedule.");
      return;
    }
    const conflict = schedules.find(
      (s: Schedule) =>
        !specificDate &&
        !s.date &&
        !form.quiet &&
        !s.quiet &&
        s.id !== form.id &&
        schedulesConflict(form, s),
    );
    if (conflict) {
      notify(`This overlaps "${conflict.name}". Adjust the days or times.`);
      return;
    }
    const overlap = playlists.find((p: any) => p.id === form.playlistId);
    onSave({
      ...form,
      playlistName: overlap?.name || "",
      name: form.name.trim(),
    });
  }
  return (
    <div
      className="overlay"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
    >
      <form className="dialog" onSubmit={submit}>
        <div className="dialog-head">
          <div>
            <h2>{initial ? "Edit schedule" : "New schedule"}</h2>
            <span>
              Configure recurring local-time playback or quiet-hour boundaries.
            </span>
          </div>
          <button type="button" className="icon-btn" onClick={onCancel}>
            <X />
          </button>
        </div>
        <label>
          Schedule name
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            required
            maxLength={80}
          />
        </label>
        <label>
          Schedule type
          <select
            value={specificDate ? "date" : "weekly"}
            onChange={(e) => {
              if (e.target.value === "date") {
                const n = new Date();
                setForm({
                  ...form,
                  date: `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`,
                  repeat: "never",
                });
              } else setForm({ ...form, date: undefined, repeat: undefined });
            }}
          >
            <option value="weekly">Weekly schedule</option>
            <option value="date">Specific date / recurring</option>
          </select>
        </label>
        {specificDate ? (
          <div className="two-fields">
            <label>
              Specific date
              <input
                type="date"
                value={form.date}
                onChange={(e) => set("date", e.target.value)}
                required
              />
            </label>
            <label>
              Repeat
              <select
                value={form.repeat || "never"}
                onChange={(e) => set("repeat", e.target.value)}
              >
                <option value="never">Never</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="yearly">Yearly</option>
              </select>
            </label>
          </div>
        ) : (
          <div className="days">
            <span>Days</span>
            {days.map((d) => (
              <button
                type="button"
                className={form.days.includes(d) ? "day active" : "day"}
                onClick={() =>
                  set(
                    "days",
                    form.days.includes(d)
                      ? form.days.filter((x) => x !== d)
                      : [...form.days, d],
                  )
                }
                key={d}
              >
                {d}
              </button>
            ))}
          </div>
        )}
        <div className="two-fields">
          <label>
            Start time
            <input
              type="time"
              value={form.start}
              onChange={(e) => set("start", e.target.value)}
              required
            />
          </label>
          <label>
            End time
            <input
              type="time"
              value={form.end}
              onChange={(e) => set("end", e.target.value)}
              required
            />
          </label>
        </div>
        <label>
          Playlist
          <select
            value={form.playlistId}
            disabled={form.quiet}
            onChange={(e) => set("playlistId", e.target.value)}
          >
            <option value="">No playlist selected</option>
            {playlists.map((p: any) => (
              <option value={p.id} key={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label className="checkline">
          <input
            type="checkbox"
            checked={form.quiet}
            onChange={(e) => set("quiet", e.target.checked)}
          />{" "}
          No Playback (eg. for Quiet Hour or When Music Should Not Be Played)
        </label>
        <label className="checkline">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(e) => set("enabled", e.target.checked)}
          />{" "}
          Enabled
        </label>
        <div className="dialog-actions">
          <button type="button" className="subtle" onClick={onCancel}>
            Cancel
          </button>
          <button className="primary">
            <Check size={17} />
            Save schedule
          </button>
        </div>
      </form>
    </div>
  );
}
