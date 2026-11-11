import rclpy
from rclpy.node import Node
from std_srvs.srv import SetBool
from screen_interfaces.srv import SetDisplayClass

CLASSES = {"organic", "plastic", "other"}


class MockScreenManager(Node):
    def __init__(self):
        super().__init__('screen_manager_node')
        self.create_service(SetBool, '~/set_display', self.on_set_display)
        self.create_service(SetDisplayClass, '~/set_display_class', self.on_set_display_class)
        self.get_logger().info('mock screen_manager_node ready')

    def on_set_display(self, request, response):
        self.get_logger().info(f'set_display data={request.data}')
        response.success = True
        response.message = 'mock ok'
        return response

    def on_set_display_class(self, request, response):
        self.get_logger().info(f'set_display_class category={request.category}')
        response.success = request.category in CLASSES
        response.message = 'mock ok' if response.success else f'unknown category: {request.category}'
        return response


def main():
    rclpy.init()
    node = MockScreenManager()
    try:
        rclpy.spin(node)
    except KeyboardInterrupt:
        pass
    finally:
        node.destroy_node()
        rclpy.shutdown()


if __name__ == '__main__':
    main()