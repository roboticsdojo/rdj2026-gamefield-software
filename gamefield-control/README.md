# Gamefield Control (judges' web page)

The Robotics Dojo 2026 judges' page.
Gamefield Pi credentials
Username: screen
Hostname: screen
Tailscale IP: 100.76.206.127

| Panel | What it does | Needs the Pi on the ROS network? |
|---|---|---|
| Gamefield Screen | live stream + buttons to show Organic / Metal / Plastic | **Yes** |
| Gamefield Dispenser | state, pieces left, dispense / home / reset / enable / cancel | **Yes** |
| Obstacle Layout | randomises 3 obstacles on a 3 x 2 grid | No |
| Map Request | ask a team for its map |
| Competition | teams, run times, scoreboard | No |

If the Pi isn't reachable, the screen and dispenser panels just report "unavailable"; the rest works.


## 1. Install (once per judges' laptop)

Ubuntu 24.04 with **ROS 2 Jazzy** (on Windows: WSL2 Ubuntu 24.04). Follow the official ROS 2 Jazzy
install, then:

```bash
sudo apt update
sudo apt install ros-jazzy-rmw-zenoh-cpp
sudo apt install -y ros-jazzy-ros-base python3-colcon-common-extensions python3-rosdep
sudo rosdep init          # skip if already done
rosdep update

cd gamefield-control
source /opt/ros/jazzy/setup.bash
rosdep install --from-paths . --ignore-src -r -y
```

| Needed | Why |
|---|---|
| ROS 2 Jazzy (`ros-jazzy-ros-base`) | `rclpy`, `std_srvs`, `action_msgs`, `ament_index_python`, build tools |
| `ros-jazzy-example-interfaces` | the screen service type |
| `ros-jazzy-rmw-zenoh-cpp` | only if the Pi uses Zenoh (the default here) |
| `python3-colcon-common-extensions` | `colcon build` |
| `fastapi`, `uvicorn` (pip) | the web server (`pydantic` comes with fastapi) |

The laptop and the Pi must be on the **same network and the same `ROS_DOMAIN_ID` (62)**, with the
**same RMW** (`rmw_zenoh_cpp` by default here) - `dojo_env.sh on` sets both on the laptop; check the
Pi uses the same.


## 2. Build (once, and again after editing code)

```bash
cd gamefield-control
source /opt/ros/jazzy/setup.bash
colcon build --symlink-install
```

## 3. Launch

```bash
cd gamefield-control
source dojo_net.sh            # Pi connected   (zenoh, ROS_DOMAIN_ID=62)
ros2 run web_pi_bridge fastapi_node
```

Open `http://localhost:8000` on that laptop, or `http://<laptop-ip>:8000` from another PC
(find the IP with `hostname -I`). The server listens on all interfaces.

#restart services
sudo systemctl restart screen_manager.service screen_stream.service
journalctl -u screen_manager.service --since "1 min ago" --no-pager | grep Discovered


Quick check from the laptop to confirm networking:
```bash
ros2 service list | grep -E "screen_manager|loading_station"
curl http://localhost:8000/api/dispenser/status
```

# Testing website locally
```
cd gamefield-control/web_pi_bridge/web_pi_bridge
python3 mock_server.py      #open http://localhost:8000/

```

# Launch barrier
```
source install/setup.bash && ros2 launch gamefield_barrier barrier.launch.py
```