import unittest

import _path  # noqa: F401
from obd.decoders import DEFAULT_FIELDS, FIELDS, decode_field, plan_fields
from obd.isotp import isotp_reassemble, find_payload

# raw frames from survey.json (Taos at idle), one per field, through the real
# ISO-TP path so the test covers frame -> payload -> value.
SURVEY_VECTORS = {
    "rpm": (["7E804410C0E80", "7E904410C0E80"], "0C", 928),
    "speed": (["7E903410D00", "7E803410D00"], "0D", 0),
    "coolant_temp": (["7E80341058C", "7E90341058C"], "05", 100),
    "engine_load": (["7E803410436", "7E903410435"], "04", 21.18),
    "throttle": (["7E80341111D"], "11", 11.37),
    "pedal": (["7E903414924", "7E803414924"], "49", 14.12),
    "intake_temp": (["7E810094168034E5000", "7E821000000AAAAAAAA"], "68", 38),
    "ambient_temp": (["7E80341463B"], "46", 19),
    "intake_map": (["7E803410B1A"], "0B", 26),
    "baro": (["7E803413364"], "33", 100),
    "fuel_level": (["7E803412FC4"], "2F", 76.86),
    "fuel_rate": (["7E806419D00090009"], "9D", 0.87),
    "module_voltage": (["7E80441423728", "7E90441423714"], "42", 14.12),
    "run_time": (["7E804411F01B2"], "1F", 434),
    "odometer": (["7E80641A600073864"], "A6", 47318.8),
    "gear": (["7E80641A401000000"], "A4", 0),
    "distance_since_clear": (["7E804413125FC"], "31", 9724),
    "mil": (["7E80641010007ED00", "7E906410100040000"], "01", 0),
    "dtc_count": (["7E80641010007ED00", "7E906410100040000"], "01", 0),
}


class DecoderTests(unittest.TestCase):
    def test_every_pid_field_has_a_survey_vector(self):
        pid_fields = [n for n, s in FIELDS.items() if s.source == "pid"]
        self.assertEqual(sorted(pid_fields), sorted(SURVEY_VECTORS))

    def test_survey_vectors(self):
        for name, (lines, pid, expected) in SURVEY_VECTORS.items():
            _, payload = find_payload(isotp_reassemble(lines), "41" + pid)
            self.assertIsNotNone(payload, name)
            value = decode_field(name, pid, payload[4:])
            self.assertIsInstance(value, (int, float), name)
            self.assertAlmostEqual(value, expected, places=2, msg=name)

    def test_fallback_pids(self):
        self.assertEqual(decode_field("intake_temp", "0F", "39"), 17)
        self.assertEqual(decode_field("fuel_rate", "5E", "0190"), 20)

    def test_mil_and_dtc_count_set(self):
        self.assertEqual(decode_field("mil", "01", "8307ED00"), 1)
        self.assertEqual(decode_field("dtc_count", "01", "8307ED00"), 3)

    def test_gear_ratio(self):
        self.assertAlmostEqual(decode_field("gear", "A4", "01000ABC"), 2.748, places=3)

    def test_short_data_raises(self):
        with self.assertRaises((ValueError, IndexError)):
            decode_field("rpm", "0C", "0E")
        with self.assertRaises((ValueError, IndexError)):
            decode_field("odometer", "A6", "0007")

    def test_plan_fields_taos(self):
        supported = {"04", "05", "0B", "0C", "0D", "11", "1F", "21", "2F", "31", "33", "42",
                     "46", "49", "62", "63", "67", "68", "9D", "A4", "A6", "01"}
        sup, unsup, plan = plan_fields(DEFAULT_FIELDS, supported)
        self.assertIn("intake_temp", sup)
        self.assertEqual(plan["68"], ["intake_temp"])
        self.assertEqual(plan["9D"], ["fuel_rate"])
        self.assertEqual(plan["01"], ["mil", "dtc_count"])
        self.assertIn("adapter_voltage", sup)
        self.assertIn("link", sup)
        self.assertEqual(unsup, [])
        self.assertNotIn("0F", plan)

    def test_plan_fields_unsupported_reported_not_polled(self):
        sup, unsup, plan = plan_fields(["rpm", "fuel_level", "intake_temp", "link"], {"0C", "0F"})
        self.assertEqual(sup, ["rpm", "intake_temp", "link"])
        self.assertEqual(unsup, ["fuel_level"])
        self.assertEqual(list(plan), ["0C", "0F"])


if __name__ == "__main__":
    unittest.main()
