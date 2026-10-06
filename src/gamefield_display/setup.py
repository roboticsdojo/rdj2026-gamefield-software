from setuptools import find_packages, setup

package_name = 'gamefield_display'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages',
            ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
    ],
    install_requires=['setuptools', 'websockets'],
    zip_safe=True,
    maintainer='uchiha',
    maintainer_email='emmanuelmututa25@gmail.com',
    description='TODO: Package description',
    license='TODO: License declaration',
    extras_require={
        'test': [
            'pytest',
        ],
    },
    entry_points={
        'console_scripts': [
            'display_node=gamefield_display.display_node:main'
        ],
    },

)
