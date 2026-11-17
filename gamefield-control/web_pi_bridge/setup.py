import os
from glob import glob
from setuptools import find_packages, setup


package_name = 'web_pi_bridge'

setup(
    name=package_name,
    version='0.0.0',
    packages=find_packages(exclude=['test']),
    data_files=[
        ('share/ament_index/resource_index/packages', ['resource/' + package_name]),
        ('share/' + package_name, ['package.xml']),
        # Organisation logos (served at /logos/...)
        (os.path.join('share', package_name, 'logos'), glob('web_pi_bridge/logos/*')),
        # Copy HTML templates directly into the installed package share directory
        (os.path.join('share', package_name, 'templates'), glob('web_pi_bridge/templates/*')),
        # Copy static assets (CSS/JS) into the installed package share directory
        (os.path.join('share', package_name, 'static'), glob('web_pi_bridge/static/*')),
    ],
    install_requires=['setuptools', 'fastapi', 'uvicorn'],
    zip_safe=True,
    maintainer='Amy Kibara',
    maintainer_email='amy.kibara@gmail.com',
    description='Communication between website and pi',
    license='Apache-2.0',
    extras_require={
        'test': [
            'pytest',
        ],
    },
    entry_points={
        'console_scripts': [
            'fastapi_node = web_pi_bridge.fastapi_node:main',
        ],
    },
)