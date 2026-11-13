import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('live_board_motion',Path(__file__).resolve().parents[2]/'tools/live_board_motion.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BoardTelemetryTests(unittest.TestCase):
    def test_si_units_axis_order_and_status(self):
        row=module.parse('[MOTION1],4,40000,1,0,200,1,2,9.8,4,5,6,7,8,9,10,11,12')
        self.assertTrue(row['ready'])
        self.assertFalse(row['holding'])
        self.assertEqual(row['position'],[10,11,12])
        self.assertEqual(row['linear_accel'],[4,5,6])
        self.assertEqual(row['raw_accel'],[1,2,9.8])
        self.assertEqual(row['velocity'],[7,8,9])

    def test_raw_and_diagnostic_lines_not_mistaken_for_motion(self):
        for line in ('IMU3,a,b','[WiFi] connected','[MOTION1],1,2',''):
            self.assertIsNone(module.parse(line))
        with self.assertRaises(ValueError):
            module.parse('[MOTION1],4,40000,1,0,200,nan,2,3,4,5,6,7,8,9,10,11,12')
