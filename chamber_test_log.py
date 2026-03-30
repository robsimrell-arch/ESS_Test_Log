"""
Chamber Test Log  v1.0
Manufacturing Thermal Test Data Logger
"""

import tkinter as tk
from tkinter import ttk, messagebox, filedialog
import sqlite3
import csv
import os
import sys
import json
from datetime import datetime

# ── Constants ────────────────────────────────────────────────────────────────
APP_TITLE   = "Chamber Test Log"
APP_VERSION = "1.0"
MAX_CHANNELS = 12

# Resolve base directory: next to the .exe when frozen, else next to the .py
if getattr(sys, 'frozen', False):
    _DIR = os.path.dirname(sys.executable)
else:
    _DIR = os.path.dirname(os.path.abspath(__file__))
DB_PATH     = os.path.join(_DIR, "chamber_test_log.db")
CONFIG_PATH = os.path.join(_DIR, "config.json")

# ── Palette ──────────────────────────────────────────────────────────────────
C_BG      = "#0d1117"
C_SURFACE = "#161b22"
C_HEADER  = "#21262d"
C_BORDER  = "#30363d"
C_ACCENT  = "#1f6feb"
C_GREEN   = "#3fb950"
C_RED     = "#f85149"
C_AMBER   = "#d29922"
C_TEXT    = "#e6edf3"
C_MUTED   = "#8b949e"

TEST_TYPES = ["Full Test", "Mini Test"]

DEFAULT_CONFIG = {
    "part_numbers": [],
    "chambers":      ["CH-01", "CH-02", "CH-03", "CH-04"],
    "test_stations": ["TS-01", "TS-02", "TS-03", "TS-04"],
}

# ── Database ─────────────────────────────────────────────────────────────────
def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            operator      TEXT NOT NULL,
            chamber       TEXT NOT NULL,
            station       TEXT NOT NULL,
            part_number   TEXT NOT NULL,
            test_type     TEXT NOT NULL,
            start_time    TEXT,
            end_time      TEXT,
            created_at    TEXT NOT NULL
        )""")
    c.execute("""
        CREATE TABLE IF NOT EXISTS uut_entries (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id     INTEGER NOT NULL,
            channel        INTEGER NOT NULL,
            uut_serial     TEXT,
            cable_serial   TEXT,
            backplane      TEXT,
            notes          TEXT,
            failure_notes  TEXT,
            result         TEXT DEFAULT '',
            FOREIGN KEY (session_id) REFERENCES sessions(id)
        )""")
    # Migrate existing DB: add result column if it doesn't exist yet
    try:
        c.execute("ALTER TABLE uut_entries ADD COLUMN result TEXT DEFAULT ''")
    except Exception:
        pass  # column already present
    # Migrate: add closed_by column to sessions
    try:
        c.execute("ALTER TABLE sessions ADD COLUMN closed_by TEXT DEFAULT ''")
    except Exception:
        pass  # column already present
    conn.commit()
    conn.close()


def db_new_session(operator, chamber, station, pn, tt):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute(
        "INSERT INTO sessions (operator,chamber,station,part_number,test_type,created_at) VALUES (?,?,?,?,?,?)",
        (operator, chamber, station, pn, tt, datetime.now().isoformat()))
    sid = c.lastrowid
    conn.commit(); conn.close()
    return sid


def db_set_start(sid, t):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE sessions SET start_time=? WHERE id=?", (t, sid))
    conn.commit(); conn.close()


def db_set_end(sid, t, closed_by=""):
    conn = sqlite3.connect(DB_PATH)
    conn.execute("UPDATE sessions SET end_time=?, closed_by=? WHERE id=?",
                 (t, closed_by, sid))
    conn.commit(); conn.close()


def db_save_entries(sid, rows):
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute("DELETE FROM uut_entries WHERE session_id=?", (sid,))
    for r in rows:
        if not r["uut_serial"] and not r["cable_serial"]:
            continue
        c.execute(
            "INSERT INTO uut_entries "
            "(session_id,channel,uut_serial,cable_serial,backplane,notes,failure_notes,result)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (sid, r["channel"], r["uut_serial"], r["cable_serial"],
             r["backplane"], r["notes"], r["failure_notes"], r.get("result", "")))
    conn.commit(); conn.close()


def db_all_sessions():
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id,operator,chamber,station,part_number,test_type,start_time,end_time,"
        "COALESCE(closed_by,'') FROM sessions ORDER BY id DESC"
    ).fetchall()
    conn.close()
    return rows


def db_session_entries(sid):
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT channel,uut_serial,cable_serial,backplane,notes,failure_notes,result"
        " FROM uut_entries WHERE session_id=? ORDER BY channel",
        (sid,)).fetchall()
    conn.close()
    return rows


def db_distinct(col):
    conn = sqlite3.connect(DB_PATH)
    rows = [r[0] for r in conn.execute(f"SELECT DISTINCT {col} FROM sessions ORDER BY {col}").fetchall()]
    conn.close()
    return rows


def fmt_ts(iso_str):
    """Convert an ISO-format DB timestamp to MM/DD/YYYY HH:MM:SS for display."""
    if not iso_str:
        return "—"
    try:
        return datetime.fromisoformat(iso_str).strftime("%m/%d/%Y %H:%M:%S")
    except (ValueError, TypeError):
        return iso_str or "—"



def db_all_tests():
    """Every UUT entry joined with session data, ordered chronologically."""
    conn = sqlite3.connect(DB_PATH)
    _q = (
        "SELECT s.start_time, s.id, s.operator, COALESCE(s.closed_by, ''),"
        " s.chamber, s.station, s.part_number, s.test_type,"
        " u.channel, u.uut_serial, u.cable_serial,"
        " COALESCE(u.backplane,''), COALESCE(u.notes,''),"
        " COALESCE(u.failure_notes,''), COALESCE(u.result,''), s.end_time"
        " FROM uut_entries u JOIN sessions s ON s.id = u.session_id"
        " WHERE u.uut_serial IS NOT NULL AND u.uut_serial != ''"
        " ORDER BY s.start_time ASC, s.id ASC, u.channel ASC"
    )
    rows = conn.execute(_q).fetchall()
    conn.close()
    return rows

def db_get_open_sessions():
    """Return sessions that were started but never ended (app was closed mid-run).
    Also returns sessions that were opened but never started (no start_time).
    Ordered oldest-first so windows stack naturally."""
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        "SELECT id,operator,chamber,station,part_number,test_type,start_time,end_time"
        " FROM sessions WHERE end_time IS NULL ORDER BY id ASC"
    ).fetchall()
    conn.close()
    return rows

def db_search_uut(serial: str):
    """
    Return every test run that included `serial` (case-insensitive partial match).
    Each row: (session_id, operator, chamber, station, part_number, test_type,
               start_time, end_time, channel, cable_serial, backplane, notes, failure_notes)
    """
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute("""
        SELECT s.id, s.operator, s.chamber, s.station, s.part_number, s.test_type,
               s.start_time, s.end_time,
               u.channel, u.cable_serial, u.backplane, u.notes, u.failure_notes, u.result
        FROM uut_entries u
        JOIN sessions s ON s.id = u.session_id
        WHERE LOWER(u.uut_serial) LIKE LOWER(?)
        ORDER BY s.start_time DESC
    """, (f"%{serial}%",)).fetchall()
    conn.close()
    return rows

# ── Config ────────────────────────────────────────────────────────────────────
def load_config():
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH) as f:
            return json.load(f)
    return DEFAULT_CONFIG.copy()


def save_config(cfg):
    with open(CONFIG_PATH, "w") as f:
        json.dump(cfg, f, indent=2)

# ── TTK Style ─────────────────────────────────────────────────────────────────
def apply_style(root):
    s = ttk.Style(root)
    s.theme_use("clam")
    s.configure(".",            background=C_BG,      foreground=C_TEXT,  font=("Segoe UI", 10))
    s.configure("TFrame",       background=C_BG)
    s.configure("TLabel",       background=C_BG,      foreground=C_TEXT)
    s.configure("Muted.TLabel", background=C_BG,      foreground=C_MUTED, font=("Segoe UI", 9))
    s.configure("TButton",      background=C_ACCENT,  foreground="white",
                relief="flat", borderwidth=0, padding=(12, 6))
    s.map("TButton",    background=[("active", "#388bfd"), ("pressed", "#1158c7")])
    s.configure("Green.TButton", background=C_GREEN, foreground="white")
    s.map("Green.TButton",  background=[("active", "#56d364"), ("disabled", C_MUTED)])
    s.configure("Red.TButton",   background=C_RED,   foreground="white")
    s.map("Red.TButton",    background=[("active", "#ff7b72"), ("disabled", C_MUTED)])
    s.configure("Ghost.TButton", background=C_HEADER, foreground=C_TEXT)
    s.map("Ghost.TButton",  background=[("active", C_BORDER)])
    s.configure("TEntry",        fieldbackground=C_HEADER, foreground=C_TEXT,
                insertcolor=C_TEXT, bordercolor=C_BORDER, relief="flat")
    s.configure("TCombobox",     fieldbackground=C_HEADER, foreground=C_TEXT,
                selectbackground=C_ACCENT)
    s.map("TCombobox", fieldbackground=[("readonly", C_HEADER)])
    s.configure("Treeview",         background=C_SURFACE, foreground=C_TEXT,
                fieldbackground=C_SURFACE, rowheight=28)
    s.configure("Treeview.Heading", background=C_HEADER,  foreground=C_TEXT,
                font=("Segoe UI", 10, "bold"), relief="flat")
    s.map("Treeview", background=[("selected", C_ACCENT)])

# ═══════════════════════════════════════════════════════════════════════════════
#  Session Setup Dialog
# ═══════════════════════════════════════════════════════════════════════════════
class SessionSetupDialog(tk.Toplevel):
    def __init__(self, parent, cfg, on_confirm):
        super().__init__(parent)
        self.cfg        = cfg
        self.on_confirm = on_confirm
        self.title("New Test Session")
        self.configure(bg=C_BG)
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        self._build()
        self.geometry("460x500")
        self._center(parent)

    def _center(self, parent):
        parent.update_idletasks()
        x = parent.winfo_x() + (parent.winfo_width()  - 460) // 2
        y = parent.winfo_y() + (parent.winfo_height() - 500) // 2
        self.geometry(f"+{x}+{y}")

    def _build(self):
        # Header
        hdr = tk.Frame(self, bg=C_SURFACE, pady=14)
        hdr.pack(fill="x")
        tk.Label(hdr, text="🧪  New Test Session", font=("Segoe UI", 14, "bold"),
                 bg=C_SURFACE, fg=C_TEXT).pack()
        tk.Label(hdr, text="All fields required", font=("Segoe UI", 9),
                 bg=C_SURFACE, fg=C_MUTED).pack()

        form = tk.Frame(self, bg=C_BG, padx=32, pady=20)
        form.pack(fill="both", expand=True)
        form.columnconfigure(0, weight=1)

        def lbl(text, row):
            tk.Label(form, text=text, bg=C_BG, fg=C_MUTED,
                     font=("Segoe UI", 9)).grid(row=row*2, column=0, sticky="w", pady=(10, 2))

        def combo(var, values, row, readonly=False):
            lbl_map = {0:"Operator Name", 1:"Chamber Number", 2:"Test Station",
                       3:"Part Number", 4:"Test Type"}
            lbl(lbl_map[row], row)
            state = "readonly" if readonly else "normal"
            cb = ttk.Combobox(form, textvariable=var, values=values,
                              font=("Segoe UI", 11), state=state)
            cb.grid(row=row*2+1, column=0, sticky="ew")
            return cb

        ops = db_distinct("operator")
        self.v_op   = tk.StringVar()
        self.v_ch   = tk.StringVar()
        self.v_st   = tk.StringVar()
        self.v_pn   = tk.StringVar()
        self.v_tt   = tk.StringVar(value=TEST_TYPES[0])

        combo(self.v_op, ops, 0)

        chambers = self.cfg.get("chambers", [])
        combo(self.v_ch, chambers, 1)

        stations = self.cfg.get("test_stations", [])
        combo(self.v_st, stations, 2)

        pns = list(dict.fromkeys(self.cfg.get("part_numbers", []) + db_distinct("part_number")))
        combo(self.v_pn, pns, 3)

        combo(self.v_tt, TEST_TYPES, 4, readonly=True)

        # Buttons
        bf = tk.Frame(self, bg=C_BG, padx=32, pady=16)
        bf.pack(fill="x", side="bottom")
        ttk.Button(bf, text="Cancel", style="Ghost.TButton",
                   command=self.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(bf, text="Open Session →",
                   command=self._confirm).pack(side="right")

    def _confirm(self):
        vals = [self.v_op.get().strip(), self.v_ch.get().strip(),
                self.v_st.get().strip(), self.v_pn.get().strip(),
                self.v_tt.get().strip()]
        if not all(vals):
            messagebox.showerror("Incomplete", "All fields are required.", parent=self)
            return
        self.on_confirm(*vals)
        self.destroy()

# ═══════════════════════════════════════════════════════════════════════════════
#  UUT Row  (12 per session)
# ═══════════════════════════════════════════════════════════════════════════════
class UUTRow:
    def __init__(self, parent, channel, idx):
        bg = C_SURFACE if idx % 2 == 0 else C_HEADER

        self.ch_lbl = tk.Label(parent, text=str(channel), width=4,
                               bg=bg, fg=C_MUTED, font=("Segoe UI", 10, "bold"), anchor="center")

        def entry(w=14):
            return tk.Entry(parent, bg=C_HEADER, fg=C_TEXT, insertbackground=C_TEXT,
                            relief="flat", font=("Segoe UI", 10), width=w,
                            highlightthickness=1, highlightcolor=C_ACCENT,
                            highlightbackground=C_BORDER)

        self.e_uut   = entry(16)
        self.e_cable = entry(16)
        self.e_bp    = entry(10)
        self.e_notes = entry(22)
        self.e_fail  = entry(22)
        self.channel = channel

        # Pass / Fail toggle
        self._result = ""
        self.btn_pf = tk.Button(
            parent, text="—", width=6,
            bg=C_HEADER, fg=C_MUTED,
            font=("Segoe UI", 9, "bold"),
            relief="flat", cursor="hand2",
            command=self._toggle)

    def _toggle(self):
        if self._result == "":
            self._set_result("PASS")
        elif self._result == "PASS":
            self._set_result("FAIL")
        elif self._result == "FAIL":
            self._set_result("ABORTED")
        else:
            self._set_result("")

    def _set_result(self, val):
        self._result = val
        if val == "PASS":
            self.btn_pf.config(text="PASS",    bg=C_GREEN,  fg="white")
        elif val == "FAIL":
            self.btn_pf.config(text="FAIL",    bg=C_RED,    fg="white")
        elif val == "ABORTED":
            self.btn_pf.config(text="ABORTED", bg=C_AMBER,  fg="white")
        else:
            self.btn_pf.config(text="—",       bg=C_HEADER, fg=C_MUTED)

    def grid_row(self, r):
        pad = {"padx": 2, "pady": 2}
        self.ch_lbl.grid (row=r, column=0, **pad, sticky="nsew")
        self.e_uut.grid  (row=r, column=1, **pad, sticky="ew")
        self.e_cable.grid(row=r, column=2, **pad, sticky="ew")
        self.e_bp.grid   (row=r, column=3, **pad, sticky="ew")
        self.e_notes.grid(row=r, column=4, **pad, sticky="ew")
        self.e_fail.grid (row=r, column=5, **pad, sticky="ew")
        self.btn_pf.grid (row=r, column=6, **pad, sticky="nsew")

    def get(self):
        return {
            "channel":      self.channel,
            "uut_serial":   self.e_uut.get().strip(),
            "cable_serial": self.e_cable.get().strip(),
            "backplane":    self.e_bp.get().strip(),
            "notes":        self.e_notes.get().strip(),
            "failure_notes":self.e_fail.get().strip(),
            "result":       self._result,
        }

    def load(self, d):
        def _set(e, v):
            e.delete(0, tk.END); e.insert(0, v or "")
        _set(self.e_uut,   d.get("uut_serial", ""))
        _set(self.e_cable, d.get("cable_serial", ""))
        _set(self.e_bp,    d.get("backplane", ""))
        _set(self.e_notes, d.get("notes", ""))
        _set(self.e_fail,  d.get("failure_notes", ""))
        self._set_result(d.get("result", ""))

# ═══════════════════════════════════════════════════════════════════════════════
#  Test Session Window
# ═══════════════════════════════════════════════════════════════════════════════
class TestSessionWindow(tk.Toplevel):
    def __init__(self, parent, sid, operator, chamber, station, pn, tt,
                 on_minimize, on_close, get_active_sessions):
        super().__init__(parent)
        self.sid                = sid
        self.operator           = operator
        self.chamber            = chamber
        self.station            = station
        self.pn                 = pn
        self.tt                 = tt
        self._on_min            = on_minimize
        self._on_close          = on_close
        self._get_active        = get_active_sessions   # () -> list[TestSessionWindow]

        self.started = False
        self.ended   = False
        self.t_start = None
        self.t_end   = None

        self.title(f"Session – {chamber}  [{pn}]")
        self.configure(bg=C_BG)
        self.protocol("WM_DELETE_WINDOW", self._close)
        # Intercept OS minimize button → redirect to our internal tab-based minimize
        self.bind("<Unmap>", self._on_iconify_check)
        self._build()
        self.geometry("1100x720")
        self._center()

    def _center(self):
        self.update_idletasks()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{(sw-1100)//2}+{(sh-720)//2}")

    # ── Build UI ──────────────────────────────────────────────────────────────
    def _build(self):
        # ── Top bar
        top = tk.Frame(self, bg=C_SURFACE, pady=10, padx=16)
        top.pack(fill="x")

        tk.Label(top, text=f"🏭  Chamber {self.chamber}",
                 font=("Segoe UI", 15, "bold"), bg=C_SURFACE, fg=C_TEXT).pack(side="left")
        meta = f"   Station: {self.station}   |   Part: {self.pn}   |   Type: {self.tt}   |   Operator: {self.operator}"
        tk.Label(top, text=meta, font=("Segoe UI", 9),
                 bg=C_SURFACE, fg=C_MUTED).pack(side="left")

        ttk.Button(top, text="⊟  Minimize", style="Ghost.TButton",
                   command=self._minimize).pack(side="right", padx=4)

        # ── Time / action bar
        tbar = tk.Frame(self, bg=C_HEADER, pady=8, padx=16)
        tbar.pack(fill="x")

        self.lbl_start  = tk.Label(tbar, text="Start: —",
                                   font=("Segoe UI", 10), bg=C_HEADER, fg=C_MUTED)
        self.lbl_start.pack(side="left")
        tk.Label(tbar, text="   |   ", bg=C_HEADER, fg=C_BORDER).pack(side="left")
        self.lbl_end    = tk.Label(tbar, text="End: —",
                                   font=("Segoe UI", 10), bg=C_HEADER, fg=C_MUTED)
        self.lbl_end.pack(side="left")
        tk.Label(tbar, text="   |   ", bg=C_HEADER, fg=C_BORDER).pack(side="left")
        self.lbl_status = tk.Label(tbar, text="\u25cf NOT STARTED",
                                   font=("Segoe UI", 10, "bold"), bg=C_HEADER, fg=C_AMBER)
        self.lbl_status.pack(side="left")
        tk.Label(tbar, text="   |   ", bg=C_HEADER, fg=C_BORDER).pack(side="left")
        self.lbl_elapsed = tk.Label(tbar, text="Elapsed: --:--:--",
                                    font=("Segoe UI", 10, "bold"), bg=C_HEADER, fg=C_MUTED)
        self.lbl_elapsed.pack(side="left")

        ttk.Button(tbar, text="📤  Export CSV", style="Ghost.TButton",
                   command=self._export).pack(side="right", padx=4)
        ttk.Button(tbar, text="💾  Save", style="Ghost.TButton",
                   command=self._save).pack(side="right", padx=4)
        self.btn_end = ttk.Button(tbar, text="■  End Session",
                                  style="Red.TButton",
                                  command=self._end, state="disabled")
        self.btn_end.pack(side="right", padx=4)
        self.btn_start = ttk.Button(tbar, text="▶  Start Session",
                                    style="Green.TButton", command=self._start)
        self.btn_start.pack(side="right", padx=4)

        # ── Scrollable body (header is row 0 inside canvas so columns align)
        outer = tk.Frame(self, bg=C_BG)
        outer.pack(fill="both", expand=True, padx=0)

        canvas = tk.Canvas(outer, bg=C_BG, highlightthickness=0)
        sb = ttk.Scrollbar(outer, orient="vertical", command=canvas.yview)
        canvas.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        canvas.pack(side="left", fill="both", expand=True)

        self.body = tk.Frame(canvas, bg=C_BG)
        cw = canvas.create_window((0, 0), window=self.body, anchor="nw")

        self.body.bind("<Configure>",
                       lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.bind("<Configure>",
                    lambda e: canvas.itemconfig(cw, width=e.width))

        # 7 columns: Ch | UUT | Cable | Backplane | Notes | Failure Notes | Result
        COL_HDR = ["Ch", "UUT Serial Number", "Cable Serial Number",
                   "Backplane #", "Operator Notes", "Failure Notes", "Result"]
        for i, h in enumerate(COL_HDR):
            tk.Label(self.body, text=h, bg=C_ACCENT, fg="white",
                     font=("Segoe UI", 10, "bold"), anchor="center",
                     pady=7).grid(row=0, column=i, padx=2, sticky="ew")

        # column weights match UUTRow layout
        self.body.columnconfigure(0, weight=0)   # Ch (fixed)
        for i in range(1, 7):
            self.body.columnconfigure(i, weight=1)

        self.rows: list[UUTRow] = []
        for i in range(MAX_CHANNELS):
            row = UUTRow(self.body, i + 1, i)
            row.grid_row(i + 1)          # +1 because row 0 = header
            self.rows.append(row)

        # mouse-wheel scroll
        canvas.bind_all("<MouseWheel>",
                        lambda e: canvas.yview_scroll(-1*(e.delta//120), "units"))

        tk.Frame(self, bg=C_BG, height=12).pack()

    # ── Actions ───────────────────────────────────────────────────────────────
    def get_elapsed_str(self):
        """Return HH:MM:SS elapsed since start, or '--:--:--' if not started."""
        if not self.started or self.t_start is None:
            return "--:--:--"
        end   = self.t_end if self.ended else datetime.now()
        secs  = max(0, int((end - self.t_start).total_seconds()))
        h, rem = divmod(secs, 3600)
        m, s   = divmod(rem, 60)
        return f"{h:02d}:{m:02d}:{s:02d}"

    def _start_tick(self):
        """Begin the live elapsed-time update loop."""
        self._tick()

    def _tick(self):
        """Update the elapsed label every second while session is running."""
        try:
            elapsed = self.get_elapsed_str()
            self.lbl_elapsed.config(
                text=f"Elapsed: {elapsed}",
                fg=C_GREEN if (self.started and not self.ended) else C_MUTED)
            if self.started and not self.ended:
                self.after(1000, self._tick)
        except tk.TclError:
            pass  # window was destroyed

    def _start(self):
        if self.started:
            return

        # ── UUT serial conflict check: block if any serial is active in another session ──
        my_serials = {r.get()["uut_serial"] for r in self.rows
                      if r.get()["uut_serial"]}
        if my_serials:
            for sess in self._get_active():
                if sess is self or not sess.started or sess.ended:
                    continue
                their_serials = {r.get()["uut_serial"] for r in sess.rows
                                 if r.get()["uut_serial"]}
                dupes = my_serials & their_serials
                if dupes:
                    dupe_list = "\n".join(f"  \u2022 {s}" for s in sorted(dupes))
                    messagebox.showerror(
                        "UUT Conflict",
                        f"The following UUT serial(s) are already active"
                        f" in Chamber {sess.chamber}:\n\n{dupe_list}\n\n"
                        f"Remove them from this session before starting.",
                        parent=self)
                    return

        if not messagebox.askyesno("Start Session",
                                   "Record the start time and begin this test session?",
                                   parent=self):
            return
        self.t_start = datetime.now()
        self.started = True
        ts = self.t_start.strftime("%m/%d/%Y %H:%M:%S")
        self.lbl_start.config(text=f"Start: {ts}", fg=C_GREEN)
        self.lbl_status.config(text="\u25cf RUNNING", fg=C_GREEN)
        self.btn_start.config(state="disabled")
        self.btn_end.config(state="normal")
        db_set_start(self.sid, self.t_start.isoformat())
        self._save()
        self._start_tick()

    def _end(self):
        if self.ended:
            return

        # ── Validate: cable serial + result required for every row with a UUT serial ──
        missing_cable  = []
        missing_result = []
        for r in self.rows:
            uut = r.e_uut.get().strip()
            if not uut:
                continue        # empty row — skip
            if not r.e_cable.get().strip():
                missing_cable.append(f"Ch {r.channel}")
            if not r._result:
                missing_result.append(f"Ch {r.channel}")

        errors = []
        if missing_cable:
            errors.append(
                f"Cable Serial required on:\n  {', '.join(missing_cable)}")
        if missing_result:
            errors.append(
                f"Pass / Fail / Aborted result required on:\n  {', '.join(missing_result)}\n"
                f"  (click the result button: \u2014 \u2192 PASS \u2192 FAIL \u2192 ABORTED)")
        if errors:
            messagebox.showerror(
                "Required Fields Missing",
                "\n\n".join(errors),
                parent=self)
            return

        dlg = EndSessionDialog(self, self)
        self.wait_window(dlg)
        if dlg.operator_result is None:
            return   # cancelled

        closing_op = dlg.operator_result
        self.t_end = datetime.now()
        self.ended = True
        self._save()
        ts = self.t_end.strftime("%m/%d/%Y %H:%M:%S")
        self.lbl_end.config(text=f"End: {ts}", fg=C_RED)
        self.lbl_status.config(text="\u25cf COMPLETED", fg=C_MUTED)
        self.btn_end.config(state="disabled")
        db_set_end(self.sid, self.t_end.isoformat(), closing_op)
        messagebox.showinfo("Session Complete",
                            f"Chamber {self.chamber} session completed.\n"
                            f"Closed by: {closing_op}\nAll data saved.",
                            parent=self)

    def _save(self):
        db_save_entries(self.sid, [r.get() for r in self.rows])

    def _export(self):
        self._save()
        fp = filedialog.asksaveasfilename(
            parent=self,
            defaultextension=".csv",
            filetypes=[("CSV Files", "*.csv")],
            initialfile=f"Chamber{self.chamber}_{self.pn}_{datetime.now().strftime('%m%d%Y_%H%M%S')}.csv",
        )
        if not fp:
            return
        with open(fp, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["Chamber Test Log – Session Export"])
            w.writerow([])
            w.writerow(["Session ID", "Operator", "Chamber", "Station",
                        "Part Number", "Test Type", "Start Time", "End Time"])
            w.writerow([self.sid, self.operator, self.chamber, self.station,
                        self.pn, self.tt,
                        self.t_start.strftime("%m/%d/%Y %H:%M:%S") if self.t_start else "",
                        self.t_end.strftime("%m/%d/%Y %H:%M:%S")   if self.t_end   else ""])
            w.writerow([])
            w.writerow(["Channel", "UUT Serial", "Cable Serial", "Backplane #",
                        "Operator Notes", "Failure Notes", "Result"])
            for e in db_session_entries(self.sid):
                w.writerow(e)
        messagebox.showinfo("Exported", f"Saved to:\n{fp}", parent=self)

    def _minimize(self):
        self._save()
        self.withdraw()
        self._on_min(self)

    def restore(self):
        self.deiconify()
        self.lift()
        self.focus_set()

    def _close(self):
        if self.started and not self.ended:
            if not messagebox.askyesno(
                    "Close Session",
                    "This session is still running.\nSave and close anyway?",
                    parent=self):
                return
        self._save()
        self._on_close(self)
        self.destroy()

    def restore_from_db(self):
        """Reload UUT rows and session state from the database after window construction."""
        entries = db_session_entries(self.sid)
        entry_map = {e[0]: e for e in entries}   # keyed by channel number
        for row in self.rows:
            if row.channel in entry_map:
                e = entry_map[row.channel]
                row.load({
                    "uut_serial":   e[1],
                    "cable_serial": e[2],
                    "backplane":    e[3],
                    "notes":        e[4],
                    "failure_notes":e[5],
                    "result":       e[6] if len(e) > 6 else "",
                })

    def _on_iconify_check(self, event):
        """Fires on <Unmap>. Detect OS-level iconify and redirect to our tab-based minimize."""
        if event.widget is not self:
            return
        # after() lets the window state settle before we read it
        self.after(10, self._intercept_iconify)

    def _intercept_iconify(self):
        """If the window was iconified by the OS (not by our own withdraw), minimise it our way."""
        try:
            if self.state() == "iconic":
                self.deiconify()        # un-send-to-taskbar
                self._minimize()        # add to main-window tab bar
        except tk.TclError:
            pass  # window already destroyed

# ═══════════════════════════════════════════════════════════════════════════════
#  Session History Window
# ═══════════════════════════════════════════════════════════════════════════════
# ═══════════════════════════════════════════════════════════════════════════════
#  End Session Dialog
# ═══════════════════════════════════════════════════════════════════════════════
class EndSessionDialog(tk.Toplevel):
    """Confirms session end and captures the closing operator's name."""
    def __init__(self, parent, session_win):
        super().__init__(parent)
        self.operator_result = None   # set on confirm
        sw = session_win
        self.title("End Test Session")
        self.configure(bg=C_BG)
        self.resizable(False, False)
        self.transient(parent)
        self.grab_set()
        self._build(sw)
        self.geometry("400x280")
        self._center(parent)

    def _center(self, p):
        p.update_idletasks()
        x = p.winfo_x() + (p.winfo_width()  - 400) // 2
        y = p.winfo_y() + (p.winfo_height() - 280) // 2
        self.geometry(f"+{x}+{y}")

    def _build(self, sw):
        # Red header
        hdr = tk.Frame(self, bg=C_RED, pady=12)
        hdr.pack(fill="x")
        tk.Label(hdr, text="■  End Test Session",
                 font=("Segoe UI", 13, "bold"), bg=C_RED, fg="white").pack()

        # Summary strip
        meta = tk.Frame(self, bg=C_SURFACE, pady=8, padx=16)
        meta.pack(fill="x")
        elapsed = sw.get_elapsed_str()
        tk.Label(meta,
                 text=f"Chamber {sw.chamber}   |   {sw.pn}   |   Elapsed: {elapsed}",
                 font=("Segoe UI", 9), bg=C_SURFACE, fg=C_MUTED).pack()

        # Form
        form = tk.Frame(self, bg=C_BG, padx=28, pady=18)
        form.pack(fill="both", expand=True)
        form.columnconfigure(0, weight=1)

        tk.Label(form, text="Closing Operator Name", bg=C_BG, fg=C_MUTED,
                 font=("Segoe UI", 9)).grid(row=0, column=0, sticky="w", pady=(0, 4))

        self.v_op = tk.StringVar(value=sw.operator)
        cb = ttk.Combobox(form, textvariable=self.v_op,
                          values=db_distinct("operator"),
                          font=("Segoe UI", 11))
        cb.grid(row=1, column=0, sticky="ew")
        cb.bind("<Return>", lambda e: self._confirm())
        cb.focus_set()
        cb.select_range(0, tk.END)

        # Buttons
        bf = tk.Frame(self, bg=C_BG, padx=28, pady=14)
        bf.pack(fill="x", side="bottom")
        ttk.Button(bf, text="Cancel", style="Ghost.TButton",
                   command=self.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(bf, text="■  Confirm End", style="Red.TButton",
                   command=self._confirm).pack(side="right")

    def _confirm(self):
        op = self.v_op.get().strip()
        if not op:
            messagebox.showerror("Required",
                                 "Please enter the closing operator name.",
                                 parent=self)
            return
        self.operator_result = op
        self.destroy()


# ═══════════════════════════════════════════════════════════════════════════════
#  Session History Window
# ═══════════════════════════════════════════════════════════════════════════════
class HistoryWindow(tk.Toplevel):
    def __init__(self, parent):
        super().__init__(parent)
        self.title("Session History")
        self.configure(bg=C_BG)
        self.geometry("1020x560")
        self._build()
        self._load()
        self._center()

    def _center(self):
        self.update_idletasks()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{(sw-1020)//2}+{(sh-560)//2}")

    def _build(self):
        hdr = tk.Frame(self, bg=C_SURFACE, pady=10, padx=16)
        hdr.pack(fill="x")
        tk.Label(hdr, text="📋  Session History", font=("Segoe UI", 14, "bold"),
                 bg=C_SURFACE, fg=C_TEXT).pack(side="left")
        ttk.Button(hdr, text="Export All CSV", style="Ghost.TButton",
                   command=self._export_all).pack(side="right", padx=4)
        ttk.Button(hdr, text="Export Selected", style="Ghost.TButton",
                   command=self._export_sel).pack(side="right", padx=4)
        ttk.Button(hdr, text="View UUT Details", command=self._detail).pack(side="right", padx=4)
        ttk.Button(hdr, text="↻ Refresh", style="Ghost.TButton",
                   command=self._load).pack(side="right", padx=4)

        cols = ("id","operator","chamber","station","part_number",
                "test_type","start_time","end_time","closed_by")
        self.tree = ttk.Treeview(self, columns=cols, show="headings", selectmode="browse")
        widths   = [45, 100, 75, 75, 110, 90, 145, 145, 100]
        headings = ["ID","Started By","Chamber","Station","Part Number",
                    "Test Type","Start Time","End Time","Closed By"]
        for col, h, w in zip(cols, headings, widths):
            self.tree.heading(col, text=h)
            self.tree.column(col, width=w, anchor="center")

        sb = ttk.Scrollbar(self, orient="vertical", command=self.tree.yview)
        self.tree.configure(yscrollcommand=sb.set)
        sb.pack(side="right", fill="y")
        self.tree.pack(fill="both", expand=True, padx=8, pady=8)

    def _load(self):
        for i in self.tree.get_children():
            self.tree.delete(i)
        for r in db_all_sessions():
            sid, op, ch, st, pn, tt, s, e, cb = r
            self.tree.insert("", "end",
                             values=(sid, op, ch, st, pn, tt,
                                     fmt_ts(s), fmt_ts(e), cb or "—"))

    def _selected_id(self):
        sel = self.tree.selection()
        if not sel:
            messagebox.showinfo("Select Row", "Please select a session first.", parent=self)
            return None
        return self.tree.item(sel[0])["values"][0]

    def _detail(self):
        sid = self._selected_id()
        if sid is None:
            return
        entries = db_session_entries(sid)
        win = tk.Toplevel(self)
        win.title(f"Session {sid} – UUT Details")
        win.configure(bg=C_BG)
        win.geometry("900x380")

        cols = ("ch","uut","cable","bp","notes","fail","result")
        hdgs = ["Channel","UUT Serial","Cable Serial","Backplane #","Operator Notes","Failure Notes","Result"]
        wids = [60,140,140,100,160,160,70]
        t = ttk.Treeview(win, columns=cols, show="headings")
        for c, h, w in zip(cols, hdgs, wids):
            t.heading(c, text=h); t.column(c, width=w, anchor="center")
        t.tag_configure("PASS",    foreground=C_GREEN)
        t.tag_configure("FAIL",    foreground=C_RED)
        t.tag_configure("ABORTED", foreground=C_AMBER)
        for e in entries:
            result_val = e[6] if len(e) > 6 else ""
            tag = result_val if result_val in ("PASS", "FAIL", "ABORTED") else ""
            t.insert("", "end", values=e, tags=(tag,))
        sb2 = ttk.Scrollbar(win, orient="vertical", command=t.yview)
        t.configure(yscrollcommand=sb2.set)
        sb2.pack(side="right", fill="y")
        t.pack(fill="both", expand=True, padx=12, pady=12)

    def _write_session_csv(self, writer, sid, header_row):
        writer.writerow(["Session ID","Started By","Chamber","Station",
                         "Part Number","Test Type","Start Time","End Time","Closed By"])
        writer.writerow(header_row)
        writer.writerow([])
        writer.writerow(["Channel","UUT Serial","Cable Serial","Backplane #",
                         "Operator Notes","Failure Notes","Result"])
        for e in db_session_entries(sid):
            writer.writerow(e)
        writer.writerow([])

    def _export_sel(self):
        sid = self._selected_id()
        if sid is None:
            return
        vals = self.tree.item(self.tree.selection()[0])["values"]
        fp = filedialog.asksaveasfilename(
            parent=self, defaultextension=".csv",
            filetypes=[("CSV Files", "*.csv")],
            initialfile=f"Session_{sid}_export.csv")
        if not fp:
            return
        with open(fp, "w", newline="") as f:
            self._write_session_csv(csv.writer(f), sid, vals)
        messagebox.showinfo("Exported", f"Saved to:\n{fp}", parent=self)

    def _export_all(self):
        fp = filedialog.asksaveasfilename(
            parent=self, defaultextension=".csv",
            filetypes=[("CSV Files", "*.csv")],
            initialfile=f"AllSessions_{datetime.now().strftime('%m%d%Y_%H%M%S')}.csv")
        if not fp:
            return
        sessions = db_all_sessions()
        with open(fp, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow(["=== Chamber Test Log – Full Export ==="])
            w.writerow([f"Exported: {datetime.now().strftime('%m/%d/%Y %H:%M:%S')}"])
            w.writerow([])
            for r in sessions:
                sid = r[0]
                w.writerow([f"--- SESSION {sid} ---"])
                self._write_session_csv(w, sid, list(r))
        messagebox.showinfo("Exported", f"All sessions saved to:\n{fp}", parent=self)

# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
#  All Tests View
# \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
class AllTestsWindow(tk.Toplevel):
    """Sortable, searchable, filterable chronological log of all UUT test entries."""

    _COLS = ("start","sid","operator","closed_by","chamber","station",
             "part_no","test_type","ch","uut","cable","backplane",
             "notes","failure_notes","result","end")
    _HDGS = ["Start Time","Sess","Started By","Closed By","Chamber",
             "Station","Part Number","Test Type","Ch",
             "UUT Serial","Cable Serial","Backplane #",
             "Operator Notes","Failure Notes","Result","End Time"]
    _WIDS = [140,45,90,90,70,70,100,80,36,130,110,80,140,140,65,140]
    _RIDX = {k: i for i, k in enumerate(_COLS)}

    def __init__(self, parent):
        super().__init__(parent)
        self.title("All Tests – Chronological Log")
        self.configure(bg=C_BG)
        self.geometry("1300x720")
        self._all_rows = []
        self._sort_ridx = 0
        self._sort_rev  = False
        self._build()
        self._load()
        self._center()

    def _center(self):
        self.update_idletasks()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{(sw-1300)//2}+{(sh-720)//2}")

    # ── Build UI ────────────────────────────────────────────────────────────────────────────
    def _build(self):
        # Header
        hdr = tk.Frame(self, bg=C_SURFACE, pady=10, padx=16)
        hdr.pack(fill="x")
        tk.Label(hdr, text="📊  All Tests – Chronological Log",
                 font=("Segoe UI", 14, "bold"), bg=C_SURFACE, fg=C_TEXT).pack(side="left")
        ttk.Button(hdr, text="↻ Refresh", style="Ghost.TButton",
                   command=self._load).pack(side="right", padx=4)
        ttk.Button(hdr, text="📤  Export CSV", style="Ghost.TButton",
                   command=self._export).pack(side="right", padx=4)

        def lbl(parent, text):
            tk.Label(parent, text=text, bg=C_HEADER, fg=C_MUTED,
                     font=("Segoe UI", 9)).pack(side="left", padx=(0, 3))

        # Filter row 1: search | result | chamber | station | type | part
        fb1 = tk.Frame(self, bg=C_HEADER, pady=7, padx=12)
        fb1.pack(fill="x")
        tk.Label(fb1, text="🔍", bg=C_HEADER, fg=C_MUTED,
                 font=("Segoe UI", 10)).pack(side="left")
        self.v_search = tk.StringVar()
        self.v_search.trace_add("write", lambda *_: self._apply_filter())
        ttk.Entry(fb1, textvariable=self.v_search, width=24,
                  font=("Segoe UI", 10)).pack(side="left", padx=(4, 18), ipady=2)

        lbl(fb1, "Result:")
        self.v_result = tk.StringVar(value="All")
        self.v_result.trace_add("write", lambda *_: self._apply_filter())
        ttk.Combobox(fb1, textvariable=self.v_result, state="readonly", width=9,
                     values=["All","PASS","FAIL","ABORTED","—"]
                     ).pack(side="left", padx=(0, 12))

        lbl(fb1, "Chamber:")
        self.v_chamber = tk.StringVar(value="All")
        self.v_chamber.trace_add("write", lambda *_: self._apply_filter())
        self.cb_chamber = ttk.Combobox(fb1, textvariable=self.v_chamber,
                                       state="readonly", width=9)
        self.cb_chamber.pack(side="left", padx=(0, 12))

        lbl(fb1, "Station:")
        self.v_station = tk.StringVar(value="All")
        self.v_station.trace_add("write", lambda *_: self._apply_filter())
        self.cb_station = ttk.Combobox(fb1, textvariable=self.v_station,
                                       state="readonly", width=9)
        self.cb_station.pack(side="left", padx=(0, 12))

        lbl(fb1, "Type:")
        self.v_testtype = tk.StringVar(value="All")
        self.v_testtype.trace_add("write", lambda *_: self._apply_filter())
        ttk.Combobox(fb1, textvariable=self.v_testtype, state="readonly", width=11,
                     values=["All","Full Test","Mini Test"]
                     ).pack(side="left", padx=(0, 12))

        lbl(fb1, "Part #:")
        self.v_part = tk.StringVar(value="All")
        self.v_part.trace_add("write", lambda *_: self._apply_filter())
        self.cb_part = ttk.Combobox(fb1, textvariable=self.v_part,
                                    state="readonly", width=11)
        self.cb_part.pack(side="left", padx=(0, 12))

        # Filter row 2: channel | cable | clear
        fb2 = tk.Frame(self, bg=C_HEADER, pady=5, padx=12)
        fb2.pack(fill="x")

        lbl(fb2, "Channel:")
        self.v_channel = tk.StringVar(value="All")
        self.v_channel.trace_add("write", lambda *_: self._apply_filter())
        self.cb_channel = ttk.Combobox(fb2, textvariable=self.v_channel,
                                       state="readonly", width=6)
        self.cb_channel.pack(side="left", padx=(0, 12))

        lbl(fb2, "Cable Serial:")
        self.v_cable = tk.StringVar(value="All")
        self.v_cable.trace_add("write", lambda *_: self._apply_filter())
        self.cb_cable = ttk.Combobox(fb2, textvariable=self.v_cable,
                                     state="readonly", width=18)
        self.cb_cable.pack(side="left", padx=(0, 12))

        ttk.Button(fb2, text="✕ Clear all filters", style="Ghost.TButton",
                   command=self._clear_filters).pack(side="left", padx=(4, 0))

        # Record count
        self.count_lbl = tk.Label(self, text="", font=("Segoe UI", 9),
                                  bg=C_BG, fg=C_MUTED)
        self.count_lbl.pack(anchor="w", padx=12, pady=(4, 0))

        # Treeview
        frame = tk.Frame(self, bg=C_BG)
        frame.pack(fill="both", expand=True, padx=8, pady=(4, 0))
        self.tree = ttk.Treeview(frame, columns=self._COLS,
                                 show="headings", selectmode="browse")
        for col, h, w in zip(self._COLS, self._HDGS, self._WIDS):
            ri = self._RIDX[col]
            self.tree.heading(col, text=h,
                              command=lambda c=col, r=ri: self._sort_by(c, r))
            self.tree.column(col, width=w, anchor="center", minwidth=36)
        self.tree.tag_configure("PASS",      foreground=C_GREEN)
        self.tree.tag_configure("FAIL",      foreground=C_RED)
        self.tree.tag_configure("ABORTED",   foreground=C_AMBER)
        self.tree.tag_configure("fail_note", foreground=C_AMBER)
        sb_y = ttk.Scrollbar(frame, orient="vertical",   command=self.tree.yview)
        sb_x = ttk.Scrollbar(self,  orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=sb_y.set, xscrollcommand=sb_x.set)
        sb_y.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        sb_x.pack(fill="x", padx=8)
        tk.Frame(self, bg=C_BG, height=6).pack()

    # ── Data helpers ──────────────────────────────────────────────────────────────────────
    def _load(self):
        self._all_rows = db_all_tests()
        def distinct(idx):
            vals = sorted({str(r[idx]) for r in self._all_rows if r[idx]})
            return vals
        self.cb_chamber["values"] = ["All"] + distinct(4)
        self.cb_station["values"] = ["All"] + distinct(5)
        self.cb_part["values"]    = ["All"] + distinct(6)
        chans = sorted({int(r[8]) for r in self._all_rows if r[8] is not None})
        self.cb_channel["values"] = ["All"] + [str(c) for c in chans]
        self.cb_cable["values"]   = ["All"] + distinct(10)
        self._apply_filter()

    def _sort_by(self, col, raw_idx):
        if self._sort_ridx == raw_idx:
            self._sort_rev = not self._sort_rev
        else:
            self._sort_ridx = raw_idx
            self._sort_rev  = False
        self._apply_filter()

    def _sort_key(self, row):
        val = row[self._sort_ridx]
        if self._sort_ridx in (1, 8):  # session id / channel -> numeric
            try: return int(val)
            except (ValueError, TypeError): return 0
        return str(val or "").lower()

    def _active_rows(self):
        """Return rows matching all active filters, in current sort order."""
        rows = self._all_rows
        # (filter_var_value, raw_tuple_index)
        for fval, idx in [
            (self.v_result.get(),  14),
            (self.v_chamber.get(), 4),
            (self.v_station.get(), 5),
            (self.v_testtype.get(),7),
            (self.v_part.get(),    6),
            (self.v_channel.get(), 8),
            (self.v_cable.get(),  10),
        ]:
            if fval == "All":
                continue
            want = "" if fval == "—" else fval
            rows = [r for r in rows if str(r[idx] or "") == str(want)]

        search = self.v_search.get().strip().lower()
        if search:
            def row_text(r):
                (ts,sid,op,cb,ch,st,pn,tt,chan,uut,cable,bp,notes,fail,res,te) = r
                return " ".join(str(v) for v in [
                    fmt_ts(ts),sid,op,cb,ch,st,pn,tt,
                    chan,uut,cable,bp,notes,fail,res,fmt_ts(te)
                ]).lower()
            rows = [r for r in rows if search in row_text(r)]

        return sorted(rows, key=self._sort_key, reverse=self._sort_rev)

    def _apply_filter(self):
        rows = self._active_rows()
        # Update heading arrows
        for col in self._COLS:
            ri  = self._RIDX[col]
            raw = self.tree.heading(col)["text"].rstrip(" ▲▼")
            arrow = (" ▼" if self._sort_rev else " ▲") if ri == self._sort_ridx else ""
            self.tree.heading(col, text=raw + arrow)
        # Repopulate tree
        for i in self.tree.get_children():
            self.tree.delete(i)
        for r in rows:
            (ts,sid,op,cb,ch,st,pn,tt,chan,uut,cable,bp,notes,fail,result,te) = r
            tag = result if result in ("PASS","FAIL","ABORTED") else \
                  ("fail_note" if fail and fail.strip() else "")
            self.tree.insert("", "end", tags=(tag,), values=(
                fmt_ts(ts), sid, op, cb or "—",
                ch, st, pn, tt, chan,
                uut, cable or "", bp or "", notes or "", fail or "",
                result or "", fmt_ts(te)))
        total = len(self._all_rows); shown = len(rows)
        suffix = "  —  filters active" if shown < total else ""
        self.count_lbl.config(text=f"{shown} of {total} record(s){suffix}")

    def _clear_filters(self):
        for v in (self.v_search, self.v_result, self.v_chamber, self.v_station,
                  self.v_testtype, self.v_part, self.v_channel, self.v_cable):
            v.set("" if v is self.v_search else "All")

    def _export(self):
        rows = self._active_rows()
        if not rows:
            messagebox.showinfo("No Data","No records match current filters.",parent=self)
            return
        fp = filedialog.asksaveasfilename(
            parent=self, defaultextension=".csv",
            filetypes=[("CSV Files","*.csv")],
            initialfile=f"AllTests_{datetime.now().strftime('%m%d%Y_%H%M%S')}.csv")
        if not fp: return
        with open(fp,"w",newline="") as f:
            w = csv.writer(f)
            w.writerow(["All Tests – Chronological Export"])
            w.writerow([f"Exported: {datetime.now().strftime('%m/%d/%Y %H:%M:%S')}"])
            w.writerow([f"Showing {len(rows)} of {len(self._all_rows)} records"])
            w.writerow([])
            w.writerow(["Start Time","Session ID","Started By","Closed By",
                        "Chamber","Station","Part Number","Test Type","Channel",
                        "UUT Serial","Cable Serial","Backplane #",
                        "Operator Notes","Failure Notes","Result","End Time"])
            for r in rows:
                (ts,sid,op,cb,ch,st,pn,tt,chan,uut,cable,bp,notes,fail,res,te)=r
                w.writerow([fmt_ts(ts),sid,op,cb,ch,st,pn,tt,
                            chan,uut,cable,bp,notes,fail,res,fmt_ts(te)])
        messagebox.showinfo("Exported", f"Saved to:\n{fp}", parent=self)


class UUTSearchWindow(tk.Toplevel):
    """
    Search for a UUT serial number and view every test run it appeared in.
    Supports partial / case-insensitive matching.
    """
    def __init__(self, parent):
        super().__init__(parent)
        self.title("UUT Serial Number Search")
        self.configure(bg=C_BG)
        self.geometry("1100x580")
        self._build()
        self._center()

    def _center(self):
        self.update_idletasks()
        sw, sh = self.winfo_screenwidth(), self.winfo_screenheight()
        self.geometry(f"+{(sw-1100)//2}+{(sh-580)//2}")

    def _build(self):
        # ── Header bar ──
        hdr = tk.Frame(self, bg=C_SURFACE, pady=12, padx=16)
        hdr.pack(fill="x")
        tk.Label(hdr, text="🔍  UUT Serial Number Search",
                 font=("Segoe UI", 14, "bold"), bg=C_SURFACE, fg=C_TEXT).pack(side="left")
        ttk.Button(hdr, text="📤  Export Results", style="Ghost.TButton",
                   command=self._export).pack(side="right", padx=4)

        # ── Search bar ──
        sbar = tk.Frame(self, bg=C_HEADER, pady=10, padx=16)
        sbar.pack(fill="x")

        tk.Label(sbar, text="UUT Serial:", font=("Segoe UI", 10),
                 bg=C_HEADER, fg=C_MUTED).pack(side="left", padx=(0, 8))

        self.search_var = tk.StringVar()
        self.search_entry = tk.Entry(
            sbar, textvariable=self.search_var,
            bg=C_BG, fg=C_TEXT, insertbackground=C_TEXT,
            relief="flat", font=("Segoe UI", 12), width=30,
            highlightthickness=2, highlightcolor=C_ACCENT, highlightbackground=C_BORDER)
        self.search_entry.pack(side="left")
        self.search_entry.bind("<Return>", lambda e: self._search())
        self.search_entry.focus_set()

        ttk.Button(sbar, text="Search", command=self._search).pack(side="left", padx=8)
        ttk.Button(sbar, text="Clear", style="Ghost.TButton",
                   command=self._clear).pack(side="left")

        self.result_lbl = tk.Label(sbar, text="", font=("Segoe UI", 9),
                                   bg=C_HEADER, fg=C_MUTED)
        self.result_lbl.pack(side="right")

        # ── Results table ──
        cols = ("session", "operator", "chamber", "station", "part_number",
                "test_type", "channel", "cable_serial", "backplane",
                "notes", "failure_notes", "result", "start_time", "end_time")
        headings = ["Session", "Operator", "Chamber", "Station", "Part Number",
                    "Test Type", "Ch", "Cable Serial", "Backplane #",
                    "Operator Notes", "Failure Notes", "Result", "Start Time", "End Time"]
        widths =   [65, 95, 75, 75, 110, 90, 40, 110, 85, 130, 130, 65, 140, 140]

        frame = tk.Frame(self, bg=C_BG)
        frame.pack(fill="both", expand=True, padx=8, pady=(6, 0))

        self.tree = ttk.Treeview(frame, columns=cols, show="headings",
                                 selectmode="browse")
        for col, h, w in zip(cols, headings, widths):
            self.tree.heading(col, text=h)
            self.tree.column(col, width=w, anchor="center", minwidth=40)

        # Row colour tags: green=PASS, red=FAIL, amber=has failure notes, plain=ok
        self.tree.tag_configure("PASS",    foreground=C_GREEN)
        self.tree.tag_configure("FAIL",    foreground=C_RED)
        self.tree.tag_configure("ABORTED", foreground=C_AMBER)
        self.tree.tag_configure("fail",    foreground=C_AMBER)
        self.tree.tag_configure("ok",      foreground=C_TEXT)

        sb_y = ttk.Scrollbar(frame, orient="vertical", command=self.tree.yview)
        sb_x = ttk.Scrollbar(self,  orient="horizontal", command=self.tree.xview)
        self.tree.configure(yscrollcommand=sb_y.set, xscrollcommand=sb_x.set)

        sb_y.pack(side="right", fill="y")
        self.tree.pack(side="left", fill="both", expand=True)
        sb_x.pack(fill="x", padx=8)

        # ── Status bar ──
        tk.Frame(self, bg=C_BG, height=6).pack()

        # Cache for export
        self._last_results = []
        self._last_query   = ""

    def _search(self):
        query = self.search_var.get().strip()
        if not query:
            messagebox.showinfo("Enter Serial", "Please enter a UUT serial number to search.",
                                parent=self)
            return

        for i in self.tree.get_children():
            self.tree.delete(i)

        rows = db_search_uut(query)
        self._last_results = rows
        self._last_query   = query

        if not rows:
            self.result_lbl.config(
                text=f'No results for "{query}"', fg=C_RED)
            return

        self.result_lbl.config(
            text=f"{len(rows)} result(s) for \"{query}\"", fg=C_GREEN)

        for r in rows:
            (sid, op, ch, st, pn, tt, t_start, t_end,
             channel, cable, bp, notes, fail, result) = r

            # Colour: explicit result takes priority over failure notes text
            if result in ("PASS", "FAIL", "ABORTED"):
                tag = result
            elif fail and fail.strip():
                tag = "fail"   # amber — has failure notes but no result button set
            else:
                tag = "ok"

            self.tree.insert("", "end", tags=(tag,), values=(
                sid, op, ch, st, pn, tt, channel,
                cable or "", bp or "", notes or "", fail or "", result or "",
                fmt_ts(t_start), fmt_ts(t_end)))

    def _clear(self):
        self.search_var.set("")
        for i in self.tree.get_children():
            self.tree.delete(i)
        self.result_lbl.config(text="")
        self._last_results = []
        self.search_entry.focus_set()

    def _export(self):
        if not self._last_results:
            messagebox.showinfo("No Results", "Perform a search first.", parent=self)
            return
        fp = filedialog.asksaveasfilename(
            parent=self, defaultextension=".csv",
            filetypes=[("CSV Files", "*.csv")],
            initialfile=f"UUT_Search_{self._last_query}_{datetime.now().strftime('%m%d%Y_%H%M%S')}.csv")
        if not fp:
            return
        with open(fp, "w", newline="") as f:
            w = csv.writer(f)
            w.writerow([f"UUT Serial Search Results – Query: {self._last_query}"])
            w.writerow([f"Exported: {datetime.now().strftime('%m/%d/%Y %H:%M:%S')}"])
            w.writerow([])
            w.writerow(["Session ID", "Operator", "Chamber", "Station", "Part Number",
                        "Test Type", "Channel", "Cable Serial", "Backplane #",
                        "Operator Notes", "Failure Notes", "Start Time", "End Time"])
            for r in self._last_results:
                w.writerow(r)
        messagebox.showinfo("Exported", f"Saved to:\n{fp}", parent=self)


# ═══════════════════════════════════════════════════════════════════════════════
#  Settings / Config Window
# ═══════════════════════════════════════════════════════════════════════════════
class SettingsWindow(tk.Toplevel):
    def __init__(self, parent, cfg, on_save):
        super().__init__(parent)
        self.cfg     = cfg
        self.on_save = on_save
        self.title("Settings")
        self.configure(bg=C_BG)
        self.resizable(False, False)
        self.transient(parent)
        self.geometry("520x580")
        self._build()
        self._center(parent)

    def _center(self, p):
        p.update_idletasks()
        x = p.winfo_x() + (p.winfo_width()  - 520) // 2
        y = p.winfo_y() + (p.winfo_height() - 580) // 2
        self.geometry(f"+{x}+{y}")

    def _build(self):
        hdr = tk.Frame(self, bg=C_SURFACE, pady=12, padx=16)
        hdr.pack(fill="x")
        tk.Label(hdr, text="⚙️  Settings", font=("Segoe UI", 14, "bold"),
                 bg=C_SURFACE, fg=C_TEXT).pack(anchor="w")

        body = tk.Frame(self, bg=C_BG, padx=24, pady=12)
        body.pack(fill="both", expand=True)

        self.listboxes = {}

        def list_editor(label, key):
            tk.Label(body, text=label, bg=C_BG, fg=C_MUTED,
                     font=("Segoe UI", 9)).pack(anchor="w", pady=(14, 2))
            lf = tk.Frame(body, bg=C_HEADER, bd=0)
            lf.pack(fill="x")
            lb = tk.Listbox(lf, bg=C_HEADER, fg=C_TEXT, selectbackground=C_ACCENT,
                            font=("Segoe UI", 10), height=4, bd=0, highlightthickness=0,
                            activestyle="none")
            lb.pack(fill="x", padx=4, pady=4)
            for item in self.cfg.get(key, []):
                lb.insert(tk.END, item)
            self.listboxes[key] = lb

            ctrl = tk.Frame(body, bg=C_BG)
            ctrl.pack(fill="x", pady=(2, 0))
            var = tk.StringVar()
            ent = tk.Entry(ctrl, textvariable=var, bg=C_HEADER, fg=C_TEXT,
                           insertbackground=C_TEXT, relief="flat",
                           font=("Segoe UI", 10),
                           highlightthickness=1, highlightbackground=C_BORDER,
                           highlightcolor=C_ACCENT)
            ent.pack(side="left", fill="x", expand=True)

            # ── hint label shown when an item is loaded for editing
            hint = tk.Label(body, text="", bg=C_BG, fg=C_AMBER,
                            font=("Segoe UI", 8, "italic"))
            hint.pack(anchor="w")

            def add(lb=lb, var=var, key=key, hint=hint):
                v = var.get().strip()
                if v and v not in lb.get(0, tk.END):
                    lb.insert(tk.END, v)
                    self.cfg[key] = list(lb.get(0, tk.END))
                var.set("")
                hint.config(text="")
                ent.config(highlightbackground=C_BORDER)

            def rem(lb=lb, key=key, hint=hint):
                sel = lb.curselection()
                if not sel:
                    messagebox.showinfo("Select Item",
                                        "Click an item in the list first.", parent=self)
                    return
                lb.delete(sel[0])
                self.cfg[key] = list(lb.get(0, tk.END))
                hint.config(text="")

            def edit(lb=lb, var=var, key=key, hint=hint, event=None):
                """Load the selected item into the entry for editing."""
                sel = lb.curselection()
                if not sel:
                    messagebox.showinfo("Select Item",
                                        "Click an item in the list first.", parent=self)
                    return
                old_val = lb.get(sel[0])
                lb.delete(sel[0])                       # remove old entry
                self.cfg[key] = list(lb.get(0, tk.END))
                var.set(old_val)                         # populate entry
                ent.icursor(tk.END)                      # cursor at end
                ent.focus_set()
                hint.config(text=f'Editing "{old_val}" — modify above then press Enter or +')
                ent.config(highlightbackground=C_AMBER)  # amber border = edit mode

            ent.bind("<Return>", lambda e, fn=add: fn())
            lb.bind("<Double-Button-1>", lambda e, fn=edit: fn())

            tk.Button(ctrl, text="+", command=add,
                      bg=C_GREEN, fg="white", font=("Segoe UI", 10, "bold"),
                      relief="flat", padx=8, cursor="hand2").pack(side="left", padx=2)
            tk.Button(ctrl, text="✎ Edit", command=edit,
                      bg=C_ACCENT, fg="white", font=("Segoe UI", 9, "bold"),
                      relief="flat", padx=8, cursor="hand2").pack(side="left", padx=2)
            tk.Button(ctrl, text="−", command=rem,
                      bg=C_RED, fg="white", font=("Segoe UI", 10, "bold"),
                      relief="flat", padx=8, cursor="hand2").pack(side="left")

        list_editor("Part Numbers",  "part_numbers")
        list_editor("Chambers",      "chambers")
        list_editor("Test Stations", "test_stations")

        bf = tk.Frame(self, bg=C_BG, padx=24, pady=16)
        bf.pack(fill="x", side="bottom")
        ttk.Button(bf, text="Cancel", style="Ghost.TButton",
                   command=self.destroy).pack(side="right", padx=(8, 0))
        ttk.Button(bf, text="Save Settings", command=self._save).pack(side="right")

    def _save(self):
        save_config(self.cfg)
        self.on_save(self.cfg)
        self.destroy()
        messagebox.showinfo("Saved", "Settings saved.")

# ═══════════════════════════════════════════════════════════════════════════════
#  Main Application
# ═══════════════════════════════════════════════════════════════════════════════
class App:
    def __init__(self, root: tk.Tk):
        self.root = root
        self.root.title(f"{APP_TITLE}  v{APP_VERSION}")
        self.root.configure(bg=C_BG)
        self.root.geometry("960x580")
        self.root.minsize(700, 420)

        init_db()
        self.cfg = load_config()
        apply_style(self.root)

        self.active:    list[TestSessionWindow] = []
        self.minimized: list[TestSessionWindow] = []
        self.min_btns:  dict[TestSessionWindow, tk.Button] = {}

        self._build()
        self.root.after(100, self._restore_sessions)  # after mainloop starts


    # ── Session Restore ────────────────────────────────────────────────────────
    def _restore_sessions(self):
        """Reopen any sessions that were active when the app was last closed."""
        open_sessions = db_get_open_sessions()
        if not open_sessions:
            return

        restored = 0
        for sid, op, ch, st, pn, tt, t_start_iso, _ in open_sessions:
            win = TestSessionWindow(
                self.root, sid, op, ch, st, pn, tt,
                on_minimize=self._on_minimize,
                on_close=self._on_close,
                get_active_sessions=lambda: self.active)

            # Populate UUT table from DB
            win.restore_from_db()

            # Restore running state if session had been started
            if t_start_iso:
                try:
                    win.t_start = datetime.fromisoformat(t_start_iso)
                except ValueError:
                    win.t_start = datetime.now()
                win.started = True
                ts = win.t_start.strftime("%m/%d/%Y %H:%M:%S")
                win.lbl_start.config(text=f"Start: {ts}", fg=C_GREEN)
                win.lbl_status.config(text="\u25cf RUNNING  (restored)", fg=C_AMBER)
                win.btn_start.config(state="disabled")
                win.btn_end.config(state="normal")
                win._start_tick()   # start live elapsed ticker for restored session

            self.active.append(win)
            restored += 1
            # Bring restored window to front
            win.lift()
            win.focus_force()

        self._refresh_stats()

        if restored:
            names = ", ".join(f"Chamber {s[2]}" for s in open_sessions)
            messagebox.showinfo(
                "Sessions Restored",
                f"{restored} active session(s) restored from previous run:\n\n{names}\n\n"
                f"Review each session and click  End Session  when the run completes.",
                parent=self.root)

    # ── Main UI ───────────────────────────────────────────────────────────────
    def _build(self):
        # Header
        hdr = tk.Frame(self.root, bg=C_SURFACE)
        hdr.pack(fill="x")
        inner = tk.Frame(hdr, bg=C_SURFACE, pady=14, padx=20)
        inner.pack(fill="x")

        left = tk.Frame(inner, bg=C_SURFACE)
        left.pack(side="left")
        tk.Label(left, text="🌡️  Chamber Test Log",
                 font=("Segoe UI", 20, "bold"), bg=C_SURFACE, fg=C_TEXT).pack(anchor="w")
        tk.Label(left, text="Manufacturing Thermal Test Data Logger",
                 font=("Segoe UI", 9), bg=C_SURFACE, fg=C_MUTED).pack(anchor="w")

        right = tk.Frame(inner, bg=C_SURFACE)
        right.pack(side="right")
        ttk.Button(right, text="⚙  Settings", style="Ghost.TButton",
                   command=self._settings).pack(side="left", padx=4)
        ttk.Button(right, text="📋  History", style="Ghost.TButton",
                   command=lambda: HistoryWindow(self.root)).pack(side="left", padx=4)
        ttk.Button(right, text="📊  All Tests", style="Ghost.TButton",
                   command=lambda: AllTestsWindow(self.root)).pack(side="left", padx=4)
        ttk.Button(right, text="🔍  Search UUT", style="Ghost.TButton",
                   command=lambda: UUTSearchWindow(self.root)).pack(side="left", padx=4)
        ttk.Button(right, text="＋  New Test Session",
                   command=self._new).pack(side="left", padx=4)

        # Accent line
        tk.Frame(self.root, bg=C_ACCENT, height=2).pack(fill="x")

        # Main body
        self.main = tk.Frame(self.root, bg=C_BG)
        self.main.pack(fill="both", expand=True)

        # Welcome area
        self.welcome = tk.Frame(self.main, bg=C_BG)
        self.welcome.pack(expand=True)

        self.welcome_icon = tk.Label(self.welcome, text="🧪", font=("Segoe UI", 52),
                 bg=C_BG, fg=C_MUTED)
        self.welcome_icon.pack(pady=(40, 6))
        self.welcome_title = tk.Label(self.welcome, text="No Active Sessions",
                 font=("Segoe UI", 17, "bold"), bg=C_BG, fg=C_TEXT)
        self.welcome_title.pack()
        self.welcome_hint = tk.Label(self.welcome,
                 text='Click  "+ New Test Session"  to begin logging a thermal test run.',
                 font=("Segoe UI", 10), bg=C_BG, fg=C_MUTED)
        self.welcome_hint.pack(pady=8)

        self.stats_frame = tk.Frame(self.welcome, bg=C_BG)
        self.stats_frame.pack(pady=20)
        self._refresh_stats()

        # Minimized sessions bar (bottom)
        self.min_bar = tk.Frame(self.root, bg=C_HEADER)
        tk.Label(self.min_bar, text="  Minimized Sessions:", font=("Segoe UI", 9),
                 bg=C_HEADER, fg=C_MUTED).pack(side="left", padx=(8, 4), pady=6)
        self.min_btn_area = tk.Frame(self.min_bar, bg=C_HEADER)
        self.min_btn_area.pack(side="left", fill="x", expand=True)

    def _refresh_stats(self):
        for w in self.stats_frame.winfo_children():
            w.destroy()
        total = len(db_all_sessions())

        # Show/hide the "No Active Sessions" placeholder
        if self.active:
            self.welcome_icon.pack_forget()
            self.welcome_title.pack_forget()
            self.welcome_hint.pack_forget()
        else:
            self.welcome_icon.pack(pady=(40, 6))
            self.welcome_title.pack()
            self.welcome_hint.pack(pady=8)

        def card(val, lbl, color):
            c = tk.Frame(self.stats_frame, bg=C_SURFACE, padx=28, pady=14)
            c.pack(side="left", padx=10)
            tk.Label(c, text=str(val), font=("Segoe UI", 26, "bold"),
                     bg=C_SURFACE, fg=color).pack()
            tk.Label(c, text=lbl, font=("Segoe UI", 9),
                     bg=C_SURFACE, fg=C_MUTED).pack()

        card(total,                "Total Sessions",    C_ACCENT)
        card(len(self.active),     "Active Sessions",   C_GREEN)
        card(len(self.minimized),  "Minimized",         C_AMBER)

    # ── Callbacks ─────────────────────────────────────────────────────────────
    def _new(self):
        def confirmed(op, ch, st, pn, tt):
            # ── Chamber & Station conflict: block if already open in any active session ──
            ch_conflicts  = [s for s in self.active if s.chamber == ch]
            st_conflicts  = [s for s in self.active if s.station == st]
            errors = []
            if ch_conflicts:
                errors.append(f"Chamber {ch} is already open in an active session."
                              f" Close or end that session first.")
            if st_conflicts:
                errors.append(f"Test Station {st} is already in use in an active session."
                              f" Close or end that session first.")
            if errors:
                messagebox.showerror("Session Conflict", "\n\n".join(errors))
                return

            sid = db_new_session(op, ch, st, pn, tt)
            win = TestSessionWindow(
                self.root, sid, op, ch, st, pn, tt,
                on_minimize=self._on_minimize,
                on_close=self._on_close,
                get_active_sessions=lambda: self.active)
            self.active.append(win)
            self._refresh_stats()
            # Bring new session window to front
            win.lift()
            win.focus_force()
            win.attributes("-topmost", True)
            win.after(200, lambda w=win: w.attributes("-topmost", False))

        SessionSetupDialog(self.root, self.cfg, confirmed)

    def _on_minimize(self, win: TestSessionWindow):
        if win not in self.minimized:
            self.minimized.append(win)
        if not self.min_bar.winfo_ismapped():
            self.min_bar.pack(fill="x", side="bottom")
        self._add_min_btn(win)
        self._refresh_stats()

    def _add_min_btn(self, win: TestSessionWindow):
        icon = ("\u25b6" if win.started and not win.ended
                else ("\u25a0" if win.ended else "\u25cb"))
        elapsed = win.get_elapsed_str() if win.started else "--:--:--"
        btn = tk.Button(
            self.min_btn_area,
            text=f"{icon}  {win.chamber}  {elapsed}",
            bg=C_SURFACE, fg=C_TEXT, font=("Segoe UI", 9),
            relief="flat", padx=10, pady=5, cursor="hand2",
            activebackground=C_ACCENT, activeforeground="white",
            command=lambda w=win: self._restore(w))
        btn.pack(side="left", padx=4, pady=4)
        self.min_btns[win] = btn
        # start the root tick if not already running
        if not getattr(self, "_root_ticking", False):
            self._root_ticking = True
            self._root_tick()

    def _root_tick(self):
        """Update all minimized session button labels with live elapsed time."""
        for win, btn in list(self.min_btns.items()):
            try:
                icon = ("\u25b6" if win.started and not win.ended
                        else ("\u25a0" if win.ended else "\u25cb"))
                elapsed = win.get_elapsed_str() if win.started else "--:--:--"
                btn.config(text=f"{icon}  {win.chamber}  {elapsed}")
            except tk.TclError:
                pass
        if self.min_btns:  # keep ticking while any minimized sessions exist
            self.root.after(1000, self._root_tick)
        else:
            self._root_ticking = False

    def _restore(self, win: TestSessionWindow):
        win.restore()
        self.minimized.remove(win)
        if win in self.min_btns:
            self.min_btns.pop(win).destroy()
        if not self.minimized:
            self.min_bar.pack_forget()
        self._refresh_stats()

    def _on_close(self, win: TestSessionWindow):
        if win in self.active:
            self.active.remove(win)
        if win in self.minimized:
            self.minimized.remove(win)
        if win in self.min_btns:
            self.min_btns.pop(win).destroy()
        if not self.minimized:
            self.min_bar.pack_forget()
        self._refresh_stats()

    def _settings(self):
        SettingsWindow(self.root, self.cfg, lambda new: setattr(self, "cfg", new))

# ═══════════════════════════════════════════════════════════════════════════════
#  Entry Point
# ═══════════════════════════════════════════════════════════════════════════════
if __name__ == "__main__":
    root = tk.Tk()
    App(root)
    root.mainloop()
