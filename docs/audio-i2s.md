# Audio / I2S notes (Argus CM5 carrier)

Field notes from the 2026-08 RGB status-LED work. The short version: the audio
overlay this board shipped with reserves two of the three status-LED GPIOs, for
a speaker amplifier the board does not have. **If you need the microphone, use
`audioinjector-bare-i2s`, not `googlevoicehat-soundcard`.**

Reference device: Argus CM5 Edge Video Node v1.0 (board ID `000` =
`ARGUS:A:A:00`), SPH0645LM4H-B I2S MEMS microphone.

## What the board actually has

The Argus carrier has an **input-only** I2S microphone and no DAC, amplifier,
speaker or any other playback sink. Per the board user guide (Rev B, I/O and
Interface Table) the mic needs exactly three pins:

| Signal | GPIO | Direction |
|---|---|---|
| `I2S0_SCLK` | 18 | out |
| `I2S0_WS` | 19 | out |
| `I2S0_SD` | 20 | **in** |

The status LED lives on three unrelated pins — `LED_RED` 12, `LED_BLUE` 16,
`LED_GREEN` 21, all active-high.

## The problem this solves

`dtoverlay=googlevoicehat-soundcard` is the recipe most people reach for when
putting an SPH0645 on a Pi, and it is what this board was brought up with. But
it describes Google's **voiceHAT** — a mic **plus speaker-amplifier** board —
so it reserves the amplifier's pins as well as the mic's. On the Argus carrier
those two pins are LEDs:

| Pin | What the voiceHAT overlay declares | What it is on Argus |
|---|---|---|
| 18 / 19 / 20 | I2S mic input | I2S mic input — correct |
| **21** | `I2S0_SDO0`, playback data to the amp | **`LED_GREEN`** |
| **16** | `sdmode`, amplifier shutdown | **`LED_BLUE`** |
| 12 | — | `LED_RED` — never claimed |

The two claims are not equally severe:

- **GPIO21 is only pinmuxed** to `a2`. Nothing owns it; `pinctrl` can take it
  and hand it back, and mic capture is provably unaffected (verified: 3 s
  captures with GPIO21 at `a2` and driven high both produced full-length,
  non-silent audio).
- **GPIO16 is held by a driver.** It appears as a real gpiod consumer, which
  means `gpioset`/libgpiod **refuse the line as busy** and only a raw `pinctrl`
  register write gets through — behind the back of a driver that believes it
  owns the pin and will drive it again whenever that ALSA card is opened:

  ```
  $ gpioinfo gpiochip0
  line  16:  "GPIO16"  "sdmode"  output  active-high  [used]

  $ dtc -I dtb -O dts /boot/firmware/overlays/googlevoicehat-soundcard.dtbo
  sdmode-gpios = <0xffffffff 0x10 0x00>;   // 0x10 = GPIO16
  brcm,pins    = <0x10>;
  ```

So the LED driver cannot own GPIO16 while this overlay is loaded. This is a
device-tree problem, not something userspace can work around safely.

## What to do

**Today: no audio overlay at all.** The microphone has never been used by this
product — there is no `audio0` channel in `kvs.json`, no audio pipeline in
`/etc/xorgate/pipelines/`, and nothing in the agent opens the card. Dropping
`dtoverlay=googlevoicehat-soundcard` from `/boot/firmware/config.txt` frees
both LED pins with nothing to replace and nothing to re-test.

**If the microphone is ever needed:** use

```
dtoverlay=audioinjector-bare-i2s
```

instead. It declares no `gpios` and no pin group of its own, so it sets up the
I2S interface on 18/19/20 and leaves GPIO16 alone. GPIO21 stays pinmuxed as
part of the ordinary I2S block, which is fine — that one is safe to claim at
runtime (see above), and the LED driver does so.

Both are `config.txt` changes and need a **reboot** to take effect.

**If you would rather do it properly:** ship a board-specific Argus overlay
that declares the mic on 18/19/20 *and* hands 12/16/21 to `gpio-leds`. That
removes both over-claims and lets the kernel blink the LED with zero CPU
(`timer` trigger), at the cost of a `.dtbo` to build and install.

## Related

- Board pin assignments and the Board ID strap (GPIO26/13/6): Argus CM5 Edge
  Video Node v1.0 User Guide Rev B.
- Status-LED design and the pin-map delivery plan: `plans/rgb_led_events/`.
