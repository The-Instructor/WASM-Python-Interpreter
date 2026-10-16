// ---------------------------------------------------------------------------
// Minimal SCORM 1.2 runtime wrapper for D2L Brightspace. Core system file.
// If no LMS API is found (local preview, instructor mode) every call is a
// safe no-op and SCORM.active is false.
// ---------------------------------------------------------------------------
(function () {
    function findAPI(win) {
        let tries = 0;
        while (win && tries < 10) {
            try { if (win.API) return win.API; } catch (e) { /* cross-origin */ }
            if (!win.parent || win.parent === win) break;
            win = win.parent;
            tries++;
        }
        return null;
    }

    function locateAPI() {
        let api = findAPI(window);
        if (!api && window.opener) api = findAPI(window.opener);
        if (!api && window.top && window.top.opener) {
            try { api = findAPI(window.top.opener); } catch (e) {}
        }
        return api;
    }

    function fmtTime(ms) {
        const s = Math.floor(ms / 1000);
        const h = String(Math.floor(s / 3600)).padStart(4, '0');
        const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
        const sec = String(s % 60).padStart(2, '0');
        return `${h}:${m}:${sec}`;
    }

    const SCORM = {
        api: null,
        active: false,
        finished: false,
        startTime: Date.now(),
        data: { best: null, last: null, runs: 0 },

        init() {
            this.api = locateAPI();
            if (!this.api) return false;
            try {
                const ok = String(this.api.LMSInitialize("")) === "true";
                if (!ok) { this.api = null; return false; }
            } catch (e) { this.api = null; return false; }
            this.active = true;
            const status = this.get("cmi.core.lesson_status");
            if (!status || status === "not attempted") {
                this.set("cmi.core.lesson_status", "incomplete");
            }
            try {
                const raw = this.get("cmi.suspend_data");
                if (raw) Object.assign(this.data, JSON.parse(raw));
            } catch (e) {}
            // Seed "best" from the gradebook value in case suspend_data was lost.
            const prior = parseFloat(this.get("cmi.core.score.raw"));
            if (!isNaN(prior)) this.data.best = this.data.best == null ? prior : Math.max(this.data.best, prior);
            this.commit();
            return true;
        },

        get(key) {
            if (!this.active) return "";
            try { return String(this.api.LMSGetValue(key) ?? ""); } catch (e) { return ""; }
        },

        set(key, value) {
            if (!this.active) return false;
            try { return String(this.api.LMSSetValue(key, String(value))) === "true"; } catch (e) { return false; }
        },

        commit() {
            if (!this.active) return false;
            try { return String(this.api.LMSCommit("")) === "true"; } catch (e) { return false; }
        },

        studentName() {
            return this.get("cmi.core.student_name");
        },

        /**
         * Report a percentage score (0-100).
         * policy: 'best' (keep highest) | 'last' (latest run counts)
         * passingScore: number 0-100, or null/0 for "completed" only.
         * Returns {sent, reported, best}.
         */
        reportScore(percent, policy, passingScore) {
            const pct = Math.max(0, Math.min(100, Math.round(percent * 100) / 100));
            this.data.runs = (this.data.runs || 0) + 1;
            this.data.last = pct;
            this.data.best = this.data.best == null ? pct : Math.max(this.data.best, pct);
            const reported = policy === 'last' ? pct : this.data.best;
            if (!this.active) return { sent: false, reported, best: this.data.best };
            this.set("cmi.core.score.min", 0);
            this.set("cmi.core.score.max", 100);
            this.set("cmi.core.score.raw", reported);
            let status = "completed";
            if (passingScore) status = reported >= passingScore ? "passed" : "failed";
            this.set("cmi.core.lesson_status", status);
            this.set("cmi.suspend_data", JSON.stringify(this.data).slice(0, 4000));
            const sent = this.commit();
            return { sent, reported, best: this.data.best };
        },

        finish() {
            if (!this.active || this.finished) return;
            this.finished = true;
            this.set("cmi.core.session_time", fmtTime(Date.now() - this.startTime));
            this.set("cmi.core.exit", "suspend"); // keep suspend_data for the next visit
            this.commit();
            try { this.api.LMSFinish(""); } catch (e) {}
        }
    };

    window.SCORM = SCORM;
})();
