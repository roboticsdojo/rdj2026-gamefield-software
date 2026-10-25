# rdj2026-gamefield-software
The pi 4 of the gamefield connects to the following network:
SSID: gamenet
Password: space_metal_welding!

## NETWORK CONFIGURATION


## MAIN DASHBOARD

## GAMEFIELD SCREEN INTEGRATION
**Services**
1. screen_manager.service
```
[Unit]
Description=ROS 2 Screen Manager Node
After=local-fs.target zenohd-router.service
Wants=zenohd-router.service
StartLimitIntervalSec=0

[Service]
Type=simple
User=screen
Group=video
Environment="HOME=/home/screen"
Environment="USER=screen"
Environment="PYTHONUNBUFFERED=1"
Environment="ROS_DOMAIN_ID=62"
Environment="RMW_IMPLEMENTATION=rmw_zenoh_cpp"
ExecStartPre=/bin/sleep 2
ExecStart=/bin/bash -c "source /opt/ros/jazzy/setup.bash && source /home/screen/ros2_ws/install/setup.bash && ros2 run screen_images screen_manager_node"
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```
2. screen_stream.service
```/etc/systemd/system/screen_stream.service
[Unit]
Description=ROS2 Screen Stream Node
After=screen_manager.service
Wants=screen_manager.service

[Service]
Type=simple
User=screen
Group=video
Environment="HOME=/home/screen"
ExecStartPre=/bin/sleep 2
ExecStart=/bin/bash -c "source /opt/ros/jazzy/setup.bash && source /home/screen/ros2_ws/install/setup.bash && ros2 run screen_images stream_node"
Restart=always
RestartSec=3
StartLimitIntervalSec=0

[Install]
WantedBy=multi-user.target
```

