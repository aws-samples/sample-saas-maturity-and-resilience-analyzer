/**
 * Interface representing a file extracted from a zip archive
 */
export interface ProjectFile {
    /**
     * Relative path of the file within the project
     */
    path: string;

    /**
     * Filename with extension
     */
    filename: string;

    /**
     * Content of the file as string
     */
    content: string;

    /**
     * File size in bytes
     */
    size: number;
}

/**
 * Interface representing a packed project
 */
export interface PackedProject {
    /**
     * Original source (zip file or multiple files)
     */
    source: string;

    /**
     * Directory structure of the project (tree representation)
     */
    directoryStructure: string;

    /**
     * List of files in the project
     */
    files: ProjectFile[];

    /**
     * Total token count (estimated)
     */
    tokenCount: number;

    /**
     * Whether the token count exceeds the warning threshold
     */
    exceedsTokenLimit: boolean;

    /**
     * The packed content as a single string
     */
    packedContent: string;
}