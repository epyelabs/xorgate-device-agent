"""Lifecycle + fault-injection tests against ELM327-emulator 4.0.0 on a pty.

Skipped (not failed) when the emulator is not installed; see
python/obd/emulator/README.md for the venv install. Each test launches a fresh
emulator with a scenario from python/obd/emulator/taos_2022.py and runs the
real helper process (python/obd_read.py) with --serial on the pty.
"""
import os
import shutil
import signal
import sys
import tempfile
import unittest

import _path  # noqa: F401
from obd.allowlist import is_allowed
from emulator_harness import Emulator, find_elm, run_helper

ELM = find_elm()


def _by_type(lines, kind):
    return [l for l in lines if l.get("type") == kind]


@unittest.skipUnless(ELM, "ELM327-emulator not installed (see python/obd/emulator/README.md)")
class EmulatorLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.audit_dir = tempfile.mkdtemp(prefix="obd-audit-")

    def tearDown(self):
        shutil.rmtree(self.audit_dir, ignore_errors=True)

    def _run(self, scenario, seconds, extra=(), poll_hz="2", until=None, stop_signal=signal.SIGTERM):
        with Emulator(scenario) as emu:
            self.emu = emu
            args = ["--serial", emu.pty, "--poll-hz", poll_hz, "--audit-dir", self.audit_dir] + list(extra)
            return run_helper(args, seconds, until=until, stop_signal=stop_signal)

    def test_taos_2022_lifecycle(self):
        code, lines, err = self._run("taos-2022", 10.0)
        self.assertEqual(code, 0, err)
        types = [l.get("type") for l in lines]
        self.assertEqual(types[0], "ready")
        ready = lines[0]
        self.assertEqual(ready["helper"], "obd_read")
        self.assertEqual(len(ready["allowlist_sha256"]), 64)
        self.assertIn("profile", types)
        self.assertLess(types.index("profile"), types.index("sample"))
        profile = _by_type(lines, "profile")[0]
        for f in ("rpm", "fuel_level", "odometer", "intake_temp"):
            self.assertIn(f, profile["supported_fields"])
        self.assertEqual(profile["responders"], ["7E8", "7E9"])
        self.assertIn("68", profile["pids_by_ecu"]["7E8"])
        self.assertEqual(profile["protocol"]["dpn"], "A6")
        self.assertEqual(profile["powertrain"], "ice")
        self.assertEqual(profile["unsupported_fields"], [])
        self.assertGreater(profile["rate_req_s"], 5)
        samples = _by_type(lines, "sample")
        self.assertGreaterEqual(len(samples), 3)
        for s in samples:
            self.assertEqual(s["fields"]["link"], 2)
            for k, v in s["fields"].items():
                self.assertIsInstance(v, (int, float), "%s=%r" % (k, v))
                self.assertNotIsInstance(v, bool)
            self.assertEqual(s["fields"]["rpm"], 928)
            self.assertEqual(s["fields"]["intake_temp"], 38)
            self.assertEqual(s["fields"]["odometer"], 47318.8)
            self.assertAlmostEqual(s["fields"]["fuel_level"], 76.86, places=2)
        states = [l["state"] for l in _by_type(lines, "status")]
        self.assertEqual(states[-1], "stopped")
        self.assertIn("live", states)
        audits = _by_type(lines, "audit")
        self.assertGreaterEqual(len(audits), 1)
        audit = audits[-1]
        c = audit["counters"]
        self.assertEqual(c["forbidden_attempts"], 0)
        self.assertEqual(c["budget_violations"], 0)
        self.assertEqual(c["err_adapter"], 0)
        self.assertEqual(c["err_protocol"], 0)
        self.assertEqual(c["timeouts"], 0)
        self.assertGreater(c["ok"], 20)
        self.assertEqual(c["requests"], sum(audit["inventory"].values()))
        for cmd in audit["inventory"]:
            self.assertTrue(is_allowed(cmd), cmd)
        # hint "1" on every Mode 01 poll, no hint on the bitmap walk
        self.assertIn("010C1", audit["inventory"])
        self.assertNotIn("010C", audit["inventory"])
        self.assertEqual(audit["inventory"]["0100"], 1)
        self.assertEqual(audit["inventory"]["ATZ"], 2)   # handshake + close
        self.assertIsNone(audit["last_stop"])
        files = os.listdir(self.audit_dir)
        self.assertEqual(len(files), 1)
        with open(os.path.join(self.audit_dir, files[0])) as f:
            kinds = [l.split('"kind":"')[1].split('"')[0] for l in f if '"kind":"' in l]
        self.assertEqual(kinds[0], "open")
        self.assertIn("session", kinds)
        self.assertEqual(kinds[-1], "close")
        self.assertEqual(kinds.count("io"), c["requests"])

    def test_sigint_also_exits_zero_with_atz(self):
        code, lines, err = self._run("taos-2022", 6.0, stop_signal=signal.SIGINT,
                                     until=lambda ls: len(_by_type(ls, "sample")) >= 1)
        self.assertEqual(code, 0, err)
        self.assertEqual(_by_type(lines, "audit")[-1]["inventory"]["ATZ"], 2)

    def test_fields_restriction(self):
        code, lines, err = self._run("taos-2022", 8.0, extra=["--fields", "rpm,speed,fuel_level,bogus"],
                                     until=lambda ls: len(_by_type(ls, "sample")) >= 2)
        self.assertEqual(code, 0, err)
        profile = _by_type(lines, "profile")[0]
        self.assertEqual(profile["supported_fields"], ["rpm", "speed", "fuel_level", "link"])
        sample = _by_type(lines, "sample")[0]
        self.assertEqual(set(sample["fields"]), {"rpm", "speed", "fuel_level", "link"})
        inv = _by_type(lines, "audit")[-1]["inventory"]
        self.assertNotIn("01051", inv)
        self.assertIn("01421", inv)   # PID 42 still polled for the voltage policy
        self.assertIn("bogus", err)

    def test_unsupported_pid_answering_no_data_is_dropped(self):
        code, lines, err = self._run("taos-2022-nodata2f", 9.0,
                                     until=lambda ls: len(_by_type(ls, "sample")) >= 4)
        self.assertEqual(code, 0, err)
        profile = _by_type(lines, "profile")[0]
        self.assertIn("fuel_level", profile["supported_fields"])   # the bitmap advertised it
        samples = _by_type(lines, "sample")
        self.assertGreaterEqual(len(samples), 4)
        for s in samples:
            self.assertNotIn("fuel_level", s["fields"])
            self.assertIn("rpm", s["fields"])
        audit = _by_type(lines, "audit")[-1]
        self.assertEqual(audit["inventory"]["012F1"], 1)
        self.assertEqual(audit["counters"]["no_data"], 1)
        self.assertEqual(audit["counters"]["forbidden_attempts"], 0)

    def test_protocol_other_than_6_or_7_is_refused_exit_4(self):
        code, lines, err = self._run("taos-2022-badproto", 20.0)
        self.assertEqual(code, 4, err)
        errors = _by_type(lines, "error")
        self.assertEqual(len(errors), 1)
        self.assertEqual(errors[0]["code"], 4)
        self.assertIn("A3", errors[0]["error"])
        self.assertEqual(_by_type(lines, "sample"), [])
        self.assertEqual(_by_type(lines, "profile"), [])
        audit = _by_type(lines, "audit")[-1]
        self.assertEqual(audit["counters"]["err_protocol"], 1)
        self.assertEqual(audit["last_stop"]["reason"], "protocol A3")
        # nothing beyond the handshake reached the car
        self.assertNotIn("010C1", audit["inventory"])
        self.assertNotIn("0120", audit["inventory"])

    def test_ecu_silent_after_three_misses_then_backoff(self):
        with Emulator("taos-2022") as emu:
            def until(ls):
                if len(_by_type(ls, "sample")) == 2 and not getattr(until, "switched", False):
                    emu.command("scenario engineoff")   # every PID now answers NO DATA
                    until.switched = True
                states = [l["state"] for l in _by_type(ls, "status")]
                return "backoff" in states
            args = ["--serial", emu.pty, "--poll-hz", "2", "--audit-dir", self.audit_dir]
            code, lines, err = run_helper(args, 25.0, until=until)
        self.assertEqual(code, 0, err)
        states = [l["state"] for l in _by_type(lines, "status")]
        self.assertIn("backoff", states)
        # WP3 joint run: the transition is its own status line, before the backoff
        self.assertIn("ecu_silent", states)
        self.assertLess(states.index("ecu_silent"), states.index("backoff"))
        silent = [l for l in _by_type(lines, "status") if l["state"] == "ecu_silent"][0]
        self.assertEqual(silent["link"], 1)
        detail = [l["detail"] for l in _by_type(lines, "status") if l["state"] == "backoff"][0]
        self.assertIn("ECU silent", detail)
        audit = _by_type(lines, "audit")[-1]
        self.assertGreaterEqual(audit["counters"]["no_data"], 3)
        self.assertEqual(audit["counters"]["forbidden_attempts"], 0)
        samples = _by_type(lines, "sample")
        self.assertGreaterEqual(len(samples), 2)
        for s in samples:   # no partial/None values even in the dying cycle
            for v in s["fields"].values():
                self.assertIsInstance(v, (int, float))


if __name__ == "__main__":
    unittest.main()
