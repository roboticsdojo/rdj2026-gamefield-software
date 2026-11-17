# web_pi_bridge

ROS 2 package (`ament_python`) that serves the judges' web page on port 8000 and bridges it to the
gamefield screen and dispenser on the Pi.

Setup, launch and troubleshooting are in the **[repo-root README](../README.md)**.

Source layout: `web_pi_bridge/fastapi_node.py` (server + ROS bridges), `web_pi_bridge/templates/index.html`,
`web_pi_bridge/static/` (JS/CSS), `web_pi_bridge/logos/` (organisation logos).