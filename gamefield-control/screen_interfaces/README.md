# screen_interfaces

Shared ROS 2 interface package. Defines the one custom service used between
`web_pi_bridge` (laptop) and `screen_images` (Pi). Both other packages depend
on this one, so build it first.

- **Build type:** `ament_cmake`
- **License:** MIT (see repo root `LICENSE`)
- **Runs on:** Pi and laptop (interface-only — no nodes of its own)

## Interface

`srv/SetDisplayClass.srv`
```
string category
---
bool success
string message
```

Request a random image from a named class (e.g. `organic`, `other`,
`plastic`); get back whether it worked and a human-readable message.

## Dependencies

```xml
<buildtool_depend>ament_cmake</buildtool_depend>
<build_depend>rosidl_default_generators</build_depend>
<exec_depend>rosidl_default_runtime</exec_depend>
```

## Building

```bash
cd ~/ros2_ws
colcon build --packages-select screen_interfaces
source install/setup.bash
```

Build this before `screen_images` or `web_pi_bridge` on a fresh checkout —
both depend on it.

## Services / launch

None — this package only generates the interface; there's nothing to run.