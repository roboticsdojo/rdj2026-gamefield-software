REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

source /opt/ros/jazzy/setup.bash
if [ -f "$REPO/install/setup.bash" ]; then
  source "$REPO/install/setup.bash"
else
  echo "NOTE: $REPO/install not found yet - run 'colcon build --symlink-install' in $REPO first."
fi

if [ "$1" = off ]; then
  unset RMW_IMPLEMENTATION ZENOH_CONFIG_OVERRIDE
  export ROS_DOMAIN_ID=99                     # isolated, no zenoh needed
  echo "Pi OFF mode (DDS, domain 99)"
else
  export RMW_IMPLEMENTATION=rmw_zenoh_cpp
  export ROS_DOMAIN_ID=62                     # must match the Pi
  if [ -n "$PI_IP" ]; then
    export ZENOH_CONFIG_OVERRIDE="connect/endpoints=[\"tcp/${PI_IP}:7447\"]"
  fi
  echo "Pi ON mode (zenoh, domain 62)${PI_IP:+, router tcp/$PI_IP:7447}"
fi