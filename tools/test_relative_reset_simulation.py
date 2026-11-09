"""Run explicitly with simulation dependencies, outside the dashboard test suite."""
import unittest
import numpy as np
from simulate_relative_reset import simulate


class RelativeResetTests(unittest.TestCase):
    def test_updates_improve_relative_motion_without_an_absolute_anchor(self):
        _, errors, absolute, records, metrics = simulate(seed=0)
        free, reset, fused = metrics.values()
        self.assertLess(fused['pre_update_rmse_m'], reset['pre_update_rmse_m'])
        self.assertLess(reset['relative_rmse_m'], free['relative_rmse_m'])
        self.assertGreater(fused['absolute_node_rmse_m'], fused['relative_rmse_m'])
        self.assertTrue(np.isfinite(errors).all())
        self.assertTrue(np.isfinite(absolute).all())
        fixes = np.array([row[:5] for row in records if row[1]])
        np.testing.assert_allclose(fixes[:, 2:], np.tile([.5, .1, .2], (30, 1)), atol=1e-12)
        self.assertGreater(np.pi * np.linalg.norm([.18, .12, .08]), .5)

    def test_fixed_seed_and_unconstrained_control_are_reproducible(self):
        a = simulate(seed=3, duration=6, period=1)
        b = simulate(seed=3, duration=6, period=2)
        np.testing.assert_array_equal(a[1][:, 0], b[1][:, 0])
        np.testing.assert_array_equal(b[1], simulate(seed=3, duration=6, period=2)[1])


if __name__ == '__main__':
    unittest.main()
