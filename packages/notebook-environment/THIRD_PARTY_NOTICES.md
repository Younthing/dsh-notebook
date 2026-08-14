# Third-Party Notices

dsh-notebook is distributed under the MIT License. Its npm package manifests identify JavaScript dependencies and their exact or ranged versions; their own licenses apply.

The runtime uses `fflate` to read verified archives. During an explicitly requested environment setup, the uv provider downloads Astral uv `0.11.32` and verifies its published checksum before use. It can then install Python 3.12 and create an environment containing `jupyter_client==8.9.1` and `ipykernel==7.3.0`. These components are not relicensed by dsh-notebook; their upstream licenses and notices continue to apply.

Release verification must regenerate the dependency license inventory and review it before publishing. This file records the components that are bundled directly or acquired by the plugin at runtime; it is not a substitute for their complete upstream license texts.
