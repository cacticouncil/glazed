# _Glazed_ - Tile Glaze Daemon, Administration, and Search Application Suite
This file contains important information about the _Glazed_ project - including
its setup and use as well as contributions to the project.

## Project Overview
_Glazed_ has been designed and developed to assist ceramic artists in Kyoto to
find tile glazes that match specific colors and/or features. It is intended to
hold information in its database derived from an expansive collection of
physical glazed tiles held at KITC in order to speed up the process of finding
matching colors for tradtional Japanese cermatic pottery creations.

## Glazed Components
There are three main components to this project:

# Glazer
Glazer is currently a React and TypeScript single-page application for
digitizing and annotating images of a physical ceramic tile database. It
enables users to upload images, create and manage annotations, run AI-powered
detection models, and export structured data for digital archiving or analysis.

More details are available in the Galzer README.

# Glazy (Search App)
Glazy is a standard application intended for end-users. It allows users to
search through a database of ceramic tiles. It provides an interface for
querying the database and displaying results in an organized manner.

# Glaze Daemon
The Glaze Daemon operates as a background server. It is responsible for storing
and managing the ceramic tile database. It provides an API for accessing and
manipulating the data, as well as tools for importing and exporting data in
various formats.
