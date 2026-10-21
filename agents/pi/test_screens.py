"""Read-only screen discovery tests using temporary sysfs/boot/dev fixtures.

Run beside pi_health.py: python3 -m unittest -v test_screens.py
No broker connection, SPI transfer, GPIO request or system configuration changes.
"""
from __future__ import annotations

import importlib.util
import struct
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_SPEC = importlib.util.spec_from_file_location(
    "pi_health_screen_tests", Path(__file__).with_name("pi_health.py")
)
assert _SPEC is not None and _SPEC.loader is not None
agent = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(agent)

MARKER = "# wifi-meter KeDei V6.2 shared userspace SPI"
OVERLAY = "dtoverlay=spi0-1cs,cs0_pin=7"
EXPECTED_KEDEI = {
    "kind": "spi", "id": "spi0.0", "driver": "kedei-v6.2",
    "model": "KeDei 3.5-inch SPI TFT LCD V6.2", "width": 480, "height": 320,
    "bpp": 16, "touch": "XPT2046 resistive", "status": "configured",
}


class ScreenDiscoveryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(
            prefix="pi-health-screen-tests-", dir=Path(__file__).parent
        )
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sys_root = self.root / "sys"
        self.dev_root = self.root / "dev"
        self.boot_config = self.root / "boot/firmware/config.txt"
        self.mapping = self.sys_root / "class/spi_master/spi0/device/of_node/cs-gpios"
        self.devices = self.sys_root / "bus/spi/devices"
        self.driver_path = self.devices / "spi0.0/driver"
        self.driver_target = None
        self._resolver_patch = None
        self._real_resolve = Path.resolve
        self.write_config(f"{MARKER}\n{OVERLAY}\n")
        self.write_mapping(struct.pack(">III", 17, 7, 1))
        self.dev_root.mkdir(parents=True)
        # Discovery only stats this node; it must never open a transport.
        (self.dev_root / "spidev0.0").touch()
        self.bind_driver("spidev")

    @staticmethod
    def write_text(path: Path, value: str):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(value, encoding="utf-8")

    def write_config(self, config: str):
        self.write_text(self.boot_config, config)

    def write_mapping(self, value: bytes):
        self.mapping.parent.mkdir(parents=True, exist_ok=True)
        self.mapping.write_bytes(value)

    def _resolve_driver(self, path, *args, **kwargs):
        # Windows can prohibit unprivileged symlink creation. Only replace the
        # single driver's resolution there; Linux tests use actual symlinks.
        if path == self.driver_path and path.exists() and self.driver_target is not None:
            return self._real_resolve(self.driver_target, *args, **kwargs)
        return self._real_resolve(path, *args, **kwargs)

    def bind_driver(self, name: str):
        target = self.sys_root / "bus/spi/drivers" / name
        target.mkdir(parents=True, exist_ok=True)
        self.driver_path.parent.mkdir(parents=True, exist_ok=True)
        if self.driver_path.exists() or self.driver_path.is_symlink():
            self.driver_path.unlink()
        self.driver_target = target
        if self._resolver_patch is not None:
            self.driver_path.touch()
            return
        try:
            self.driver_path.symlink_to(target, target_is_directory=True)
        except OSError as exc:
            if getattr(exc, "winerror", None) != 1314:
                raise
            self.driver_path.touch()
            self._resolver_patch = patch.object(
                Path, "resolve", autospec=True, side_effect=self._resolve_driver
            )
            self._resolver_patch.start()
            self.addCleanup(self._resolver_patch.stop)

    def kedei(self):
        return agent._kedei_screen(self.sys_root, self.boot_config, self.dev_root)

    def screens(self):
        return agent.screens(self.sys_root, self.boot_config, self.dev_root)

    def add_framebuffer(self, name="fb0", driver="fb_ili9486", size="480,320", bpp="16", rotate="90"):
        directory = self.sys_root / "class/graphics" / name
        for field, value in (("name", driver), ("virtual_size", size),
                             ("bits_per_pixel", bpp), ("rotate", rotate)):
            self.write_text(directory / field, value + "\n")

    def add_port(self, name, status, modes):
        directory = self.sys_root / "class/drm" / name
        self.write_text(directory / "status", status + "\n")
        self.write_text(directory / "modes", modes)

    def test_valid_configured_kedei_has_explicit_model_and_touch(self):
        self.assertEqual(self.kedei(), EXPECTED_KEDEI)
        self.assertEqual(self.screens(), [EXPECTED_KEDEI])
        self.assertEqual(self.kedei()["status"], "configured")

    def test_active_overlay_accepts_comments_and_option_whitespace(self):
        self.write_config(f"  {MARKER}  \n  dtoverlay=spi0-1cs, cs0_pin=7 # installed\n")
        self.assertEqual(self.kedei(), EXPECTED_KEDEI)

    def test_missing_or_inexact_marker_does_not_label_generic_spi_as_lcd(self):
        for marker in ("", "# unrelated", MARKER + " extra", "# " + MARKER):
            with self.subTest(marker=marker):
                self.write_config(f"{marker}\n{OVERLAY}\n")
                self.assertIsNone(self.kedei())

    def test_generic_two_chip_select_spi_is_not_an_identified_display(self):
        self.write_config("dtparam=spi=on\n")
        self.write_mapping(struct.pack(">IIIIII", 17, 8, 1, 17, 7, 1))
        (self.devices / "spi0.1").mkdir()
        (self.dev_root / "spidev0.1").touch()
        self.assertEqual(self.screens(), [])

    def test_commented_missing_or_wrong_overlay_is_rejected(self):
        for overlay in ("", "# " + OVERLAY, "dtparam=spi=on",
                        "dtoverlay=spi0-2cs,cs0_pin=7",
                        "dtoverlay=spi0-1cs,cs0_pin=8", "dtoverlay=spi0-1cs",
                        "dtoverlay=spi0-1cs,cs0_pin=7,cs1_pin=8"):
            with self.subTest(overlay=overlay):
                self.write_config(f"{MARKER}\n{overlay}\n")
                self.assertIsNone(self.kedei())

    def test_current_live_mapping_overrides_the_boot_claim(self):
        for pin, flags in ((8, 1), (7, 0), (7, 2), (25, 1)):
            with self.subTest(pin=pin, flags=flags):
                self.write_mapping(struct.pack(">III", 17, pin, flags))
                self.assertIsNone(self.kedei())

    def test_malformed_device_tree_property_is_rejected_without_exception(self):
        for value in (b"", b"\0" * 11, b"\0" * 13,
                      struct.pack(">III", 0, 7, 1),
                      struct.pack("<III", 17, 7, 1)):
            with self.subTest(value=value):
                self.write_mapping(value)
                self.assertIsNone(self.kedei())

    def test_extra_live_chip_select_is_rejected(self):
        self.write_mapping(struct.pack(">IIIIII", 17, 7, 1, 17, 8, 1))
        self.assertIsNone(self.kedei())

    def test_extra_spi0_kernel_device_is_rejected(self):
        (self.devices / "spi0.1").mkdir()
        self.assertIsNone(self.kedei())

    def test_unrelated_spi_bus_does_not_hide_valid_kedei(self):
        (self.devices / "spi1.0").mkdir()
        self.assertEqual(self.kedei(), EXPECTED_KEDEI)

    def test_wrong_bound_driver_is_rejected(self):
        self.bind_driver("ads7846")
        self.assertIsNone(self.kedei())

    def test_missing_driver_is_rejected_without_exception(self):
        self.driver_path.unlink()
        self.assertIsNone(self.kedei())

    def test_missing_spidev_node_is_rejected(self):
        (self.dev_root / "spidev0.0").unlink()
        self.assertIsNone(self.kedei())

    def test_missing_device_tree_property_is_rejected_without_exception(self):
        self.mapping.unlink()
        self.assertIsNone(self.kedei())

    def test_missing_boot_config_is_rejected_without_exception(self):
        self.boot_config.unlink()
        self.assertIsNone(self.kedei())

    def test_detection_never_opens_a_spi_or_gpio_device(self):
        real_open = Path.open
        dev_root = self.dev_root
        def read_only_open(path, *args, **kwargs):
            if path == dev_root or dev_root in path.parents:
                raise AssertionError(f"Discovery opened a device node: {path}")
            return real_open(path, *args, **kwargs)
        with patch.object(Path, "open", autospec=True, side_effect=read_only_open), \
             patch.object(agent.subprocess, "run", side_effect=AssertionError("Discovery executed a command")):
            self.assertEqual(self.screens(), [EXPECTED_KEDEI])

    def test_huga_framebuffer_and_drm_ports_are_unchanged_without_kedei(self):
        self.write_config("# Existing HUGA installation\ndtoverlay=huga35,rotate=90\n")
        self.add_framebuffer()
        self.add_framebuffer("fb1", "vc4drmfb", "1920,1080", "32", "0")
        self.add_port("card1-HDMI-A-1", "connected", "1920x1080\n1280x720\n")
        self.add_port("card1-HDMI-A-2", "disconnected", "")
        self.add_port("card1-Writeback-1", "connected", "480x320\n")
        self.assertEqual(self.screens(), [
            {"kind": "framebuffer", "id": "fb0", "driver": "fb_ili9486",
             "width": 480, "height": 320, "bpp": 16, "rotate": 90},
            {"kind": "framebuffer", "id": "fb1", "driver": "vc4drmfb",
             "width": 1920, "height": 1080, "bpp": 32, "rotate": 0},
            {"kind": "port", "id": "HDMI-A-1", "status": "connected", "mode": "1920x1080"},
            {"kind": "port", "id": "HDMI-A-2", "status": "disconnected", "mode": None},
        ])

    def test_huga_and_kedei_can_both_be_reported(self):
        self.add_framebuffer()
        self.add_port("card1-HDMI-A-1", "disconnected", "")
        detected = self.screens()
        self.assertEqual([screen["kind"] for screen in detected], ["framebuffer", "spi", "port"])
        self.assertEqual(detected[0]["driver"], "fb_ili9486")
        self.assertEqual(detected[1], EXPECTED_KEDEI)
        self.assertEqual(detected[2]["status"], "disconnected")

    def test_missing_optional_framebuffer_fields_keep_existing_defaults(self):
        self.write_config("# no KeDei\n")
        self.add_framebuffer()
        for field in ("name", "bits_per_pixel", "rotate"):
            (self.sys_root / "class/graphics/fb0" / field).unlink()
        self.assertEqual(self.screens(), [{
            "kind": "framebuffer", "id": "fb0", "driver": None,
            "width": 480, "height": 320, "bpp": None, "rotate": 0,
        }])

    def test_missing_sysfs_and_boot_files_return_no_screens(self):
        self.assertEqual(agent.screens(self.root / "absent-sys", self.root / "absent-config",
                                       self.root / "absent-dev"), [])


if __name__ == "__main__":
    unittest.main()
